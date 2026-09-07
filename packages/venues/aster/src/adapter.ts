import { privateKeyToAccount } from 'viem/accounts'
import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import type { Ticker } from '@openwhaleorg/exchange'
import { TerminalAdapterError } from '@openwhaleorg/core'

export interface AsterCredentials {
  /** Master account wallet address — Aster's `user`. Identity and funds; its key is never held here. */
  walletAddress: string
  /** The API WALLET's private key — Aster's signer. Created at asterdex.com/en/api-wallet (Pro API). */
  privateKey: string
  /**
   * The API wallet's own address — Aster's `signer`. Derived from the private
   * key when omitted, which is the normal case: a mistyped signer is rejected
   * by the venue as a bad signature, with nothing on the request that says so.
   */
  signerAddress?: string
  /** Aster has no public testnet — passing true fails loudly instead of silently trading mainnet. */
  testnet?: boolean
}

const HEX_KEY = /^(0x)?[0-9a-fA-F]{64}$/

/**
 * Milliseconds of client-side budget per unit of request weight.
 *
 * Aster publishes its own limits in `GET /fapi/v1/exchangeInfo`: 2400 weight a
 * minute, which is 25ms per unit. ccxt ships 333 — thirteen times more
 * conservative than the venue asks for — and its leaky bucket makes the NEXT
 * request pay for the last one's weight, so a weight-30 read (the position
 * mode) parked the order behind it for ten seconds. Measured on a live pair:
 * opens 0.8s, closes 10s and 20s.
 *
 * 30ms rather than the exact 25 leaves ~17% headroom, because the limit is per
 * IP and this process is not the only thing on it: several accounts each hold
 * their own bucket, and none of them can see the others. Zero would remove the
 * queue altogether and hand the venue's 429 — and, on repeat, its multi-hour
 * 418 IP ban — to a live engine, which is a worse day than a slow order.
 */
const RATE_LIMIT_MS = 30

/**
 * Which of Aster's two account systems a call without a symbol means.
 *
 * ccxt ships `defaultType: 'spot'`, and this adapter is registered for the
 * 'exchange/perp' kind — so `fetchBalance()`, which takes no symbol, read the
 * SPOT wallet: empty, on an account whose collateral and positions are all on
 * the futures side. The account showed $-0.03 of equity while holding $112 of
 * positions, and the equity curve drew that zero.
 *
 * Calls that name a symbol were never affected — the market carries its own
 * type — which is why positions and orders looked right beside a balance that
 * did not.
 */
const PERP = 'swap'

/**
 * Aster's websocket event names, as its own handlers already expect them.
 *
 * ccxt 4.5.52 dispatches aster's stream frames on `data.e` through a table
 * keyed by STREAM SUFFIX — 'depth20', 'ticker', 'markPrice' — while the venue
 * sends the event names Binance does: 'depthUpdate', '24hrTicker',
 * 'markPriceUpdate'. Nothing matches, so the frames are dropped without a
 * word: the subscription succeeds, the venue pushes (measured 2026-08-31:
 * snxxusdt@depth20 delivered 42 frames in 12s), and `watchOrderBook`'s promise
 * simply never resolves. A silence with no error to catch and no throw to
 * restart on — which is what a whole strategy went quiet on.
 *
 * The handlers themselves are correct: ccxt's own handleOrderBook and
 * handleTicker document the very payloads the venue sends. Only the lookup is
 * wrong, so this renames the event to the key the table has rather than
 * reimplementing anything.
 */
const WS_EVENT_ALIASES: Record<string, string> = {
  depthUpdate: 'depth20',        // → handleOrderBook (parses b/a as a snapshot)
  '24hrTicker': 'ticker',        // → handleTicker
  markPriceUpdate: 'markPrice',  // → handleTicker
}

/** Frames aster sends; only `e` is read here. */
interface WsFrame { e?: unknown; data?: { e?: unknown } }

/**
 * Rewrite the event name on the way in, before ccxt's dispatcher reads it.
 *
 * Wrapping handleMessage rather than patching ccxt keeps this to the one venue
 * that needs it, and it falls away by itself: once upstream keys the table on
 * the real names, the alias simply stops matching anything.
 */
export function patchWsEventNames(exchange: {
  handleMessage: (client: unknown, message: unknown) => void
}): void {
  const original = exchange.handleMessage.bind(exchange)
  exchange.handleMessage = (client: unknown, message: unknown) => {
    const frame = message as WsFrame | null
    const inner = (frame && typeof frame === 'object' && frame.data && typeof frame.data === 'object')
      ? frame.data
      : frame
    const event = inner?.e
    if (typeof event === 'string') {
      const alias = WS_EVENT_ALIASES[event]
      if (alias !== undefined && inner) inner.e = alias
    }
    original(client, message)
  }
}

/**
 * Aster perpetual DEX adapter (asterdex.com).
 *
 * Authentication is an API WALLET, not an API key. Every private v3 request is
 * EIP-712 typed data (`AsterSignTransaction`, chainId 1666) carrying
 * `user` = the master wallet address, `signer` = the API wallet address, and a
 * signature made with the API wallet's private key. ccxt 4.5.52 removed the
 * HMAC path entirely — `requiredCredentials` is `privateKey` alone, and
 * passing an apiKey/secret pair now raises NotSupported.
 *
 * The master wallet's own key is never needed and must never be pasted here:
 * an API wallet is a delegated signer, so a leaked one cannot move the funds
 * the master account holds.
 */

/**
 * A ticker feed built from the streams Aster actually pushes.
 *
 * ccxt's `watchTicker` subscribes to `@ticker`, the 24-hour rolling summary,
 * which the venue only sends when a trade prints. On the leveraged-equity
 * markets this engine trades that can be minutes apart — measured on a Sunday,
 * `snxxusdt@ticker` sent NOTHING in twelve seconds while `snxxusdt@bookTicker`
 * sent 403 frames. A quote feed that only speaks when someone trades is not a
 * quote feed.
 *
 * So: the quote comes from bookTicker, the last traded price from aggTrade, and
 * the 24-hour figures from one REST snapshot at subscribe time. Every field
 * still means what it says — `last` is a real trade, not a mid dressed up as
 * one — and the fields that move continuously now move continuously.
 */
async function watchTickerViaQuotes(
  adapter: CcxtAdapter,
  exchange: {
    watchBidsAsks: (symbols: string[]) => Promise<Record<string, { bid?: number; ask?: number; timestamp?: number }>>
    watchTrades: (symbol: string) => Promise<Array<{ price?: number; timestamp?: number }>>
  },
  symbol: string,
  callback: (ticker: Ticker) => void,
  signal?: AbortSignal,
): Promise<void> {
  // The 24h frame of reference, once. Its absence must not stop the feed: a
  // strategy reading bid/ask does not care about yesterday's high.
  let base: Ticker
  try {
    base = await adapter.fetchTicker(symbol)
  } catch {
    base = { symbol, timestamp: Date.now(), last: 0, bid: 0, ask: 0, high: 0, low: 0, volume: 0, quoteVolume: 0 }
  }

  const emit = (over: Partial<Ticker>) => {
    base = { ...base, ...over }
    callback(base)
  }

  const quotes = (async () => {
    while (!signal?.aborted) {
      const map = await exchange.watchBidsAsks([symbol])
      const t = map[symbol]
      if (!t) continue
      emit({
        ...(t.bid !== undefined ? { bid: t.bid } : {}),
        ...(t.ask !== undefined ? { ask: t.ask } : {}),
        timestamp: t.timestamp ?? Date.now(),
      })
    }
  })()

  const trades = (async () => {
    while (!signal?.aborted) {
      const rows = await exchange.watchTrades(symbol)
      const last = rows[rows.length - 1]
      if (last?.price !== undefined) emit({ last: last.price, timestamp: last.timestamp ?? Date.now() })
    }
  })()

  // Either stream ending ends the feed, exactly as a single watch would: the
  // caller reconnects, and a half-live ticker is worse than a restarted one.
  try {
    await Promise.race([quotes, trades, new Promise<void>(resolve => {
      if (signal) signal.addEventListener('abort', () => resolve(), { once: true })
    })])
  } finally {
    // The loop that did not settle the race is still awaiting a frame. Once we
    // have returned, its eventual failure has no one to tell — and an
    // unhandled rejection takes the process down with it.
    void quotes.catch(() => undefined)
    void trades.catch(() => undefined)
  }
}

export class AsterAdapter extends CcxtAdapter {
  constructor(credentials: AsterCredentials) {
    if (credentials.testnet) {
      throw new TerminalAdapterError(
        'Aster has no testnet/sandbox — remove the testnet flag from this credential. ' +
        'All Aster orders are live.'
      )
    }
    const { walletAddress, privateKey } = credentials
    if (!walletAddress || !privateKey) {
      throw new TerminalAdapterError(
        'Aster now authenticates with an API wallet: this credential needs the master wallet address ' +
        'and the API wallet private key. An older API key / secret credential cannot sign v3 requests — ' +
        'create a new one at asterdex.com/en/api-wallet (Pro API).'
      )
    }
    if (!HEX_KEY.test(privateKey)) {
      throw new TerminalAdapterError(
        'Aster private key must be the API wallet key: 64 hex characters, with or without the 0x prefix.'
      )
    }
    const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`
    // Derived, not asked for: the signer address IS the key's address, and
    // ccxt refuses to sign without it (`requires signerAddress in options`).
    const signerAddress = credentials.signerAddress?.trim() || privateKeyToAccount(key).address
    super({
      exchangeId: 'aster',
      walletAddress,
      privateKey: key,
      rateLimitMs: RATE_LIMIT_MS,
      ccxtOptions: { options: { signerAddress, defaultType: PERP } },
    })
    patchWsEventNames(this.exchange as unknown as { handleMessage: (client: unknown, message: unknown) => void })
  }

  /** See {@link watchTickerViaQuotes}: Aster's `@ticker` stream waits for trades. */
  override async watchTicker(symbol: string, callback: (ticker: Ticker) => void, signal?: AbortSignal): Promise<void> {
    return watchTickerViaQuotes(this, this.exchange as never, symbol, callback, signal)
  }
}

/**
 * Aster without credentials — public market data.
 *
 * A separate class only so the websocket patch reaches this path too: order
 * book and ticker feeds run on the keyless adapter, and they are exactly what
 * the dropped frames silenced.
 */
export class AsterPublicAdapter extends CcxtAdapter {
  constructor() {
    super({ exchangeId: 'aster', rateLimitMs: RATE_LIMIT_MS, ccxtOptions: { options: { defaultType: PERP } } })
    patchWsEventNames(this.exchange as unknown as { handleMessage: (client: unknown, message: unknown) => void })
  }

  /** See {@link watchTickerViaQuotes}: Aster's `@ticker` stream waits for trades. */
  override async watchTicker(symbol: string, callback: (ticker: Ticker) => void, signal?: AbortSignal): Promise<void> {
    return watchTickerViaQuotes(this, this.exchange as never, symbol, callback, signal)
  }
}
