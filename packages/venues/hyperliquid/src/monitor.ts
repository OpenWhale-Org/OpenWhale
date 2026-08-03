import { BaseMonitor, MonitorMode, OwMonitor, createLogger } from '@openwhaleorg/core'
import type { MonitorContext } from '@openwhaleorg/core'
import { z } from 'zod'
import type { ExchangeTrade } from '@openwhaleorg/exchange'
import { exchangeTradeSchema } from '@openwhaleorg/exchange'
import { HyperliquidAdapter } from './adapter.js'

const log = createLogger('UserTradesMonitor')

/** Max remembered trade ids per address before the oldest are evicted. */
const SEEN_TRADES_LIMIT = 2000

export interface UserTradesMonitorOptions {
  /** Watch the Hyperliquid testnet instead of mainnet. Default: false. */
  testnet?: boolean
}

interface Subscription {
  controller: AbortController
  adapter: HyperliquidAdapter
}

/**
 * Monitors real-time trades for a specific wallet address on Hyperliquid.
 *
 * key: target wallet address (e.g. "0xABC...")
 * data: ExchangeTrade — one trade per emit
 *
 * Each subscribed address gets its own ccxt exchange instance: ccxt's
 * hyperliquid watchMyTrades keeps a single per-instance 'myTrades' cache
 * with no user attribution, so a shared instance would deliver address A's
 * fills to address B's subscription.
 *
 * Emitted trades are deduplicated by trade id — Hyperliquid resends a fills
 * snapshot on every WebSocket reconnect, which would otherwise be replayed
 * as fresh trades.
 */
@OwMonitor({
  id: 'user-trades',
  name: 'Hyperliquid User Trades',
  description: 'Streams real-time fills for any Hyperliquid address. Key: the wallet address.',
})
export class UserTradesMonitor extends BaseMonitor<string, ExchangeTrade> {
  readonly mode = MonitorMode.Subscribe

  private readonly subscriptions = new Map<string, Subscription>()
  /** Per-address ids of already-emitted trades. Sets iterate in insertion order, enabling FIFO eviction. */
  private readonly seenTrades = new Map<string, Set<string>>()

  private readonly options: UserTradesMonitorOptions

  // Mainnet-fixed by default: watching a target's testnet fills has no copy value
  constructor(ctx?: MonitorContext, options: UserTradesMonitorOptions = {}) {
    super(ctx?.dataDir !== undefined ? { dataDir: ctx.dataDir } : undefined)
    this.options = options
  }

  get monitorName(): string {
    return 'user-trades'
  }

  override get emitSchema() {
    return exchangeTradeSchema
  }

  override get keySchema() {
    return z.object({
      address: z.string().regex(/^0x[0-9a-fA-F]{40}$/)
        .meta({ displayName: 'Wallet Address', placeholder: '0x…', description: 'Hyperliquid address whose fills to stream' }),
    })
  }

  protected startSubscribe(key: string): void {
    log.info({ address: key }, 'Starting subscription')
    const controller = new AbortController()
    const adapter = new HyperliquidAdapter({
      walletAddress: key,
      testnet: this.options.testnet ?? false,
    })
    this.subscriptions.set(key, { controller, adapter })
    // Trades with earlier timestamps are historical backfill from ccxt and must be ignored.
    const subscribedAt = Date.now()
    void this.watchLoop(key, adapter, controller.signal, subscribedAt)
  }

  protected stopSubscribe(key: string): void {
    log.info({ address: key }, 'Stopping subscription')
    const sub = this.subscriptions.get(key)
    sub?.controller.abort()
    void sub?.adapter.close().catch(err =>
      log.warn({ address: key, err }, 'Error closing adapter')
    )
    this.subscriptions.delete(key)
    this.seenTrades.delete(key)
  }

  /** True the first time a trade id is seen for this address; false on replays. */
  private isNewTrade(address: string, trade: ExchangeTrade): boolean {
    if (!trade.id) return true
    let seen = this.seenTrades.get(address)
    if (!seen) {
      seen = new Set()
      this.seenTrades.set(address, seen)
    }
    if (seen.has(trade.id)) return false
    seen.add(trade.id)
    for (const oldest of seen) {
      if (seen.size <= SEEN_TRADES_LIMIT) break
      seen.delete(oldest)
    }
    return true
  }

  private async watchLoop(
    address: string,
    adapter: HyperliquidAdapter,
    signal: AbortSignal,
    subscribedAt: number,
  ): Promise<void> {
    log.debug({ address }, 'Watch loop started')
    let reconnects = 0

    while (!signal.aborted) {
      try {
        log.debug({ address, reconnects }, 'Connecting to userFills stream')
        await adapter.watchMyTrades(
          async (trades) => {
            const newTrades = trades.filter(t =>
              t.timestamp >= subscribedAt && this.isNewTrade(address, t)
            )
            if (trades.length !== newTrades.length)
              log.debug({ address, total: trades.length, filtered: trades.length - newTrades.length }, 'Filtered historical/duplicate trades')
            for (const trade of newTrades) {
              if (signal.aborted) return
              log.info(
                {
                  address,
                  symbol: trade.symbol,
                  side: trade.side,
                  price: trade.price,
                  amount: trade.amount,
                  cost: trade.cost,
                  takerOrMaker: trade.takerOrMaker,
                  tradeId: trade.id,
                  timestamp: trade.timestamp,
                },
                'Trade received',
              )
              await this.push(address, trade)
            }
          },
          { user: address },
          signal,
        )
        if (signal.aborted) break
        reconnects = 0
      } catch (err: any) {
        if (signal.aborted) return
        reconnects++
        log.warn({ address, reconnects, err: err?.message }, 'Stream error — reconnecting in 2s')
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    log.debug({ address }, 'Watch loop exited')
  }
}
