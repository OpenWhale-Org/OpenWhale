import { createLogger } from '@openwhaleorg/core'

/**
 * One market map per venue, loaded once, shared by every adapter on it.
 *
 * ccxt loads markets per exchange INSTANCE, and this engine holds one instance
 * per account plus a keyless one. On Hyperliquid a load is not one request: it
 * walks every HIP-3 dex at weight 20 apiece — 13 requests, ~260 weight — and
 * six adapters booting together walk six times inside one second. Measured
 * 2026-09-03: 2010 weight in the boot minute against a budget of 1200, and
 * the venue answered 429 to the tail of every walk.
 *
 * The worse half: ccxt keeps the REJECTED promise. `loadMarkets()` memoises
 * `marketsLoading` and never clears it on failure, so an adapter whose boot
 * walk drew a 429 rethrows that same 429 on every call for the life of the
 * process — no new request is ever made, so no meter sees it and no probe
 * from the same IP reproduces it. A boot either came up clean and ran nine
 * hours without a 429, or came up poisoned and failed every position read
 * until the next restart. That was the "429 storm" of 2026-09-02/03.
 *
 * Here: the first adapter to ask walks; the others await that walk, then
 * take its markets (and the helper tables the walk leaves in `options` —
 * ccxt's own `marketHelperProps` names them) without a request of their own.
 * A failed walk is forgotten after a short hold, so the next caller retries
 * instead of inheriting the failure — and during the hold it fails fast with
 * the same error rather than piling a second walk onto a venue already
 * saying no. Nothing here is a throttle: an order is never made to wait on
 * bookkeeping, only spared a walk it did not need.
 */

const log = createLogger('MarketMap')

/** How long a failed walk is held before the next caller may try again. */
export const FAILED_LOAD_HOLD_MS = 5_000

interface CcxtLike {
  id: string
  markets?: Record<string, unknown> | undefined
  currencies?: Record<string, unknown> | undefined
  options: Record<string, unknown>
  marketsLoading?: Promise<unknown> | undefined
  loadMarkets: (reload?: boolean, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  setMarkets: (markets: Record<string, unknown> | unknown[], currencies?: Record<string, unknown>) => Record<string, unknown>
}

interface Shared {
  /** The walk in progress, if any. */
  loading?: Promise<Record<string, unknown>> | undefined
  markets?: Record<string, unknown> | undefined
  currencies?: Record<string, unknown> | undefined
  /** What the walk left behind in `options` — parsers read these later. */
  helpers?: Record<string, unknown> | undefined
  failedAt?: number | undefined
  error?: unknown
}

const shared = new Map<string, Shared>()

/** For tests: forget every venue's map. */
export function resetMarketMaps(): void { shared.clear() }

/**
 * Which `options` keys a market walk populates on this venue. ccxt lists them
 * per exchange as `marketHelperProps`; the spot currency map is the one it
 * leaves out.
 */
function helperKeys(exchange: CcxtLike): string[] {
  const listed = exchange.options['marketHelperProps']
  const keys = Array.isArray(listed) ? listed.filter((k): k is string => typeof k === 'string') : []
  return [...new Set([...keys, 'spotCurrencyMapping'])]
}

function adopt(exchange: CcxtLike, from: Shared): Record<string, unknown> {
  for (const [k, v] of Object.entries(from.helpers ?? {})) exchange.options[k] = v
  return exchange.setMarkets(from.markets!, from.currencies)
}

/**
 * Make this instance's `loadMarkets` share one walk per `key` (venue, or
 * venue + sandbox). Returns the instance.
 */
export function shareMarketMap<T extends CcxtLike>(exchange: T, key: string = exchange.id): T {
  const original = exchange.loadMarkets.bind(exchange)
  exchange.loadMarkets = async (reload = false, params = {}) => {
    // This instance already holds a map and nobody asked for a fresh one.
    if (!reload && exchange.markets) return exchange.markets
    const entry = shared.get(key) ?? {}
    shared.set(key, entry)
    if (!reload) {
      if (entry.markets) return adopt(exchange, entry)
      if (entry.loading) {
        await entry.loading
        return adopt(exchange, entry)
      }
      if (entry.failedAt !== undefined && Date.now() - entry.failedAt < FAILED_LOAD_HOLD_MS) throw entry.error
    }
    const walk = original(reload, params).then(
      (markets) => {
        entry.markets = markets
        entry.currencies = exchange.currencies
        entry.helpers = Object.fromEntries(helperKeys(exchange).map(k => [k, exchange.options[k]]).filter(([, v]) => v !== undefined))
        entry.failedAt = undefined
        entry.error = undefined
        return markets
      },
      (err: unknown) => {
        entry.failedAt = Date.now()
        entry.error = err
        // ccxt memoised the rejection; without this every later call on this
        // instance rethrows it without ever asking the venue again.
        exchange.marketsLoading = undefined
        log.warn({ venue: key, err }, 'Market map load failed — held briefly, then retried by the next caller')
        throw err
      },
    ).finally(() => { if (entry.loading === walk) entry.loading = undefined })
    entry.loading = walk
    return walk
  }
  return exchange
}
