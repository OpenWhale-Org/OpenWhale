import { TerminalAdapterError } from '@openwhaleorg/core'
import type {
  PerpExchangeAdapter, Ticker, Kline, OrderBook, MarketInfo, ExchangeBalance, ExchangePosition,
  ExchangeOrder, ExchangeTrade, FundingRateData, OpenInterestData, PerpOrderParams,
} from '@openwhaleorg/exchange'

/**
 * Variational Omni — public market data only.
 *
 * Omni is an RFQ venue on Arbitrum: every trade is quoted by one liquidity
 * provider (OLP), there is no order book, and fees are zero (the cost is the
 * spread). Its trading API "is still in development, and is not yet available
 * to any users" (docs.variational.io/technical-documentation/api). What it
 * does publish is one read-only endpoint, `/metadata/stats`, carrying every
 * listing's mark price, size-tiered quotes, funding and open interest.
 *
 * So this adapter serves that and refuses the rest by name. Account and order
 * methods throw a terminal error rather than pretending: an executor that
 * reaches one should stop, not retry.
 *
 * One request feeds every call. The endpoint allows 10 requests per 10s per
 * IP, and the whole venue fits in one response, so calls share a cached copy
 * and never fetch more than once per `minIntervalMs`.
 */

export const STATS_URL = 'https://omni-client-api.prod.ap-northeast-1.variational.io/metadata/stats'
const SETTLE = 'USDC'
const HOURS_PER_YEAR = 8_760

type Side = { bid: string; ask: string }

/** One listing as `/metadata/stats` returns it. Numbers are strings. */
export interface VariationalListing {
  ticker: string
  name: string
  mark_price: string
  volume_24h: string
  open_interest: { long_open_interest: string; short_open_interest: string }
  /** Annualized, as a decimal: 0.1095 = the 0.00125%/h base rate × 8760h. */
  funding_rate: string
  /** 0 on a handful of synthetic products that do not settle funding. */
  funding_interval_s: number
  base_spread_bps: string
  quotes: {
    updated_at: string
    base?: Side
    size_1k?: Side
    size_100k?: Side
    size_1m?: Side
  }
}

export interface VariationalStats {
  total_volume_24h: string
  open_interest: string
  num_markets: number
  listings: VariationalListing[]
}

export interface VariationalAdapterOptions {
  /** Injected for tests. */
  fetch?: typeof fetch
  url?: string
  /** Minimum time between two requests to the venue. Default 1.5s. */
  minIntervalMs?: number
  /** How long a stale copy may stand in when the venue refuses (429 / 5xx). Default 60s. */
  staleGraceMs?: number
}

const NO_API = 'Variational has no public trading or account API yet (docs.variational.io/technical-documentation/api) — this adapter serves market data only'

export const symbolOf = (ticker: string): string => `${ticker}/${SETTLE}:${SETTLE}`
export const tickerOf = (symbol: string): string => symbol.split('/')[0]!.toUpperCase()
const num = (s: string | undefined): number => (s === undefined ? NaN : Number(s))

/**
 * The per-settlement rate from Variational's annualized one: the venue
 * publishes a yearly decimal (verified against its 0.00125%/h base rate), the
 * rest of the system reads the rate paid at one settlement.
 */
export function perIntervalRate(annualized: number, intervalSeconds: number): number {
  return annualized * (intervalSeconds / 3_600) / HOURS_PER_YEAR
}

/**
 * The next settlement on a UTC-aligned grid. Variational does not publish
 * settlement times; it follows Bybit's and Binance's intervals, which settle
 * on UTC multiples of the period.
 */
export function nextSettlement(now: number, intervalSeconds: number): number {
  const period = intervalSeconds * 1_000
  return (Math.floor(now / period) + 1) * period
}

/**
 * The quote ladder as a book.
 *
 * Omni quotes a price per trade SIZE — $1k, $100k, $1m — not resting orders.
 * Each tier becomes the marginal chunk up to that size, priced at the tier's
 * quote. The tier price is the average for the whole size, so pricing only the
 * increment at it slightly flatters depth; good enough for sizing, not for
 * exact fill prediction.
 */
export function ladderBook(l: VariationalListing): Pick<OrderBook, 'bids' | 'asks'> {
  const tiers: Array<[Side | undefined, number]> = [
    [l.quotes.base ?? l.quotes.size_1k, 1_000],
    [l.quotes.size_100k, 100_000],
    [l.quotes.size_1m, 1_000_000],
  ]
  const bids: [number, number][] = [], asks: [number, number][] = []
  let covered = 0
  for (const [side, size] of tiers) {
    if (!side) continue
    const chunk = size - covered
    covered = size
    const bid = num(side.bid), ask = num(side.ask)
    if (bid > 0) bids.push([bid, chunk / bid])
    if (ask > 0) asks.push([ask, chunk / ask])
  }
  return { bids, asks }
}

export class VariationalAdapter implements PerpExchangeAdapter {
  readonly supportsPositionSide = false
  private readonly fetchImpl: typeof fetch
  private readonly url: string
  private readonly minIntervalMs: number
  private readonly staleGraceMs: number
  private cached: { at: number; stats: VariationalStats } | undefined
  private inflight: Promise<VariationalStats> | undefined

  constructor(options: VariationalAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch
    this.url = options.url ?? STATS_URL
    this.minIntervalMs = options.minIntervalMs ?? 1_500
    this.staleGraceMs = options.staleGraceMs ?? 60_000
  }

  // ── The one request ─────────────────────────────────────────────────────

  /** The whole venue, from cache when it is fresh enough. */
  async stats(): Promise<VariationalStats> {
    const now = Date.now()
    if (this.cached && now - this.cached.at < this.minIntervalMs) return this.cached.stats
    this.inflight ??= this.load().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  private async load(): Promise<VariationalStats> {
    try {
      const res = await this.fetchImpl(this.url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`Variational /metadata/stats answered ${res.status}`)
      const stats = await res.json() as VariationalStats
      if (!Array.isArray(stats.listings)) throw new Error('Variational /metadata/stats returned no listings')
      this.cached = { at: Date.now(), stats }
      return stats
    } catch (err) {
      // A refused poll is not a market outage: the last copy stands for a
      // while, and its quotes carry their own timestamp for anyone gating on age.
      if (this.cached && Date.now() - this.cached.at < this.staleGraceMs) return this.cached.stats
      throw err
    }
  }

  private async listing(symbol: string): Promise<VariationalListing> {
    const ticker = tickerOf(symbol)
    const hit = (await this.stats()).listings.find(l => l.ticker === ticker)
    if (!hit) throw new TerminalAdapterError(`Variational has no market ${ticker}`)
    return hit
  }

  // ── Market data ──────────────────────────────────────────────────────────

  async fetchMarkets(): Promise<MarketInfo[]> {
    return (await this.stats()).listings.map(l => ({
      symbol: symbolOf(l.ticker), base: l.ticker, quote: SETTLE, settle: SETTLE, type: 'swap' as const, active: true,
    }))
  }

  async fetchTicker(symbol: string): Promise<Ticker> {
    return tickerFrom(await this.listing(symbol))
  }

  async fetchOrderBook(symbol: string, depth?: number): Promise<OrderBook> {
    const l = await this.listing(symbol)
    const { bids, asks } = ladderBook(l)
    const n = depth ?? bids.length
    return { symbol: symbolOf(l.ticker), timestamp: quoteTime(l), bids: bids.slice(0, n), asks: asks.slice(0, n) }
  }

  async fetchFundingRates(): Promise<FundingRateData[]> {
    const now = Date.now()
    return (await this.stats()).listings
      // Interval 0 marks products that do not settle funding.
      .filter(l => l.funding_interval_s > 0)
      .map(l => fundingFrom(l, now))
  }

  async fetchFundingRate(symbol: string): Promise<FundingRateData> {
    const l = await this.listing(symbol)
    if (!(l.funding_interval_s > 0)) throw new TerminalAdapterError(`Variational ${l.ticker} does not settle funding`)
    return fundingFrom(l, Date.now())
  }

  async fetchFundingIntervals(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const l of (await this.stats()).listings) {
      if (l.funding_interval_s > 0) out[symbolOf(l.ticker)] = l.funding_interval_s / 3_600
    }
    return out
  }

  /**
   * Users' longs and shorts do not net — OLP takes the other side of both —
   * so open interest is their sum, in dollars as the venue reports it.
   */
  async fetchOpenInterest(symbol: string): Promise<OpenInterestData> {
    const l = await this.listing(symbol)
    const value = num(l.open_interest.long_open_interest) + num(l.open_interest.short_open_interest)
    const mark = num(l.mark_price)
    return { symbol: symbolOf(l.ticker), timestamp: quoteTime(l), amount: mark > 0 ? value / mark : 0, value }
  }

  async baseAmountToContracts(_symbol: string, baseAmount: number): Promise<number> {
    return baseAmount
  }

  /** No lot size is published; amounts pass through untouched. */
  async amountToPrecision(_symbol: string, amount: number): Promise<number> {
    return amount
  }

  async fetchOHLCV(_symbol: string, _timeframe: string, _limit?: number, _since?: number): Promise<Kline[]> {
    throw new TerminalAdapterError('Variational publishes no candles')
  }

  async fetchTrades(_symbol: string, _limit?: number): Promise<ExchangeTrade[]> {
    throw new TerminalAdapterError('Variational publishes no public trades')
  }

  // ── Streams: polling the same endpoint ───────────────────────────────────

  /** Calls back whenever the venue's quote timestamp moves. */
  async watchTicker(symbol: string, callback: (ticker: Ticker) => void, signal?: AbortSignal): Promise<void> {
    await this.poll(signal, async (last) => {
      const t = tickerFrom(await this.listing(symbol))
      if (t.timestamp !== last) callback(t)
      return t.timestamp
    })
  }

  async watchOrderBook(symbol: string, callback: (orderBook: OrderBook) => void, depth?: number, signal?: AbortSignal): Promise<void> {
    await this.poll(signal, async (last) => {
      const book = await this.fetchOrderBook(symbol, depth)
      if (book.timestamp !== last) callback(book)
      return book.timestamp
    })
  }

  async watchTrades(_symbol: string, _callback: (trades: ExchangeTrade[]) => void, _signal?: AbortSignal): Promise<void> {
    throw new TerminalAdapterError('Variational publishes no public trades')
  }

  private async poll(signal: AbortSignal | undefined, step: (last: number | undefined) => Promise<number>): Promise<void> {
    let last: number | undefined
    while (!signal?.aborted) {
      try { last = await step(last) } catch { /* the next poll tries again */ }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.minIntervalMs)
        signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
      })
    }
  }

  // ── Account and trading: not offered by the venue ───────────────────────

  async fetchBalance(): Promise<ExchangeBalance[]> { throw new TerminalAdapterError(NO_API) }
  async fetchPositions(_symbols?: string[]): Promise<ExchangePosition[]> { throw new TerminalAdapterError(NO_API) }
  async fetchPosition(_symbol: string): Promise<ExchangePosition> { throw new TerminalAdapterError(NO_API) }
  async fetchOpenOrders(_symbol?: string): Promise<ExchangeOrder[]> { throw new TerminalAdapterError(NO_API) }
  async fetchOrders(_symbol?: string, _limit?: number): Promise<ExchangeOrder[]> { throw new TerminalAdapterError(NO_API) }
  async fetchOrder(_orderId: string, _symbol: string): Promise<ExchangeOrder> { throw new TerminalAdapterError(NO_API) }
  async fetchMyTrades(_symbol?: string, _limit?: number): Promise<ExchangeTrade[]> { throw new TerminalAdapterError(NO_API) }
  async createOrder(_params: PerpOrderParams): Promise<ExchangeOrder> { throw new TerminalAdapterError(NO_API) }
  async cancelOrder(_orderId: string, _symbol: string): Promise<void> { throw new TerminalAdapterError(NO_API) }
  async cancelAllOrders(_symbol?: string): Promise<void> { throw new TerminalAdapterError(NO_API) }
  async setLeverage(_symbol: string, _leverage: number, _params?: Record<string, unknown>): Promise<void> { throw new TerminalAdapterError(NO_API) }
  async setMarginMode(_symbol: string, _mode: 'cross' | 'isolated', _params?: Record<string, unknown>): Promise<void> { throw new TerminalAdapterError(NO_API) }
  async watchMyTrades(_callback: (trades: ExchangeTrade[]) => void, _params?: Record<string, unknown>, _signal?: AbortSignal): Promise<void> { throw new TerminalAdapterError(NO_API) }
  async watchOrders(_symbol: string | undefined, _callback: (orders: ExchangeOrder[]) => void, _signal?: AbortSignal): Promise<void> { throw new TerminalAdapterError(NO_API) }

  async close(): Promise<void> {
    this.cached = undefined
  }
}

/** When the venue last refreshed this listing's quotes — they can lag by minutes. */
function quoteTime(l: VariationalListing): number {
  const t = Date.parse(l.quotes.updated_at)
  return Number.isFinite(t) ? t : Date.now()
}

function tickerFrom(l: VariationalListing): Ticker {
  const top = l.quotes.base ?? l.quotes.size_1k
  const mark = num(l.mark_price)
  const quoteVolume = num(l.volume_24h)
  return {
    symbol: symbolOf(l.ticker),
    timestamp: quoteTime(l),
    // No trade tape: the mark stands in for the last price.
    last: mark,
    bid: num(top?.bid),
    ask: num(top?.ask),
    // Not published.
    high: NaN,
    low: NaN,
    volume: mark > 0 ? quoteVolume / mark : 0,
    quoteVolume,
  }
}

function fundingFrom(l: VariationalListing, now: number): FundingRateData {
  const next = nextSettlement(now, l.funding_interval_s)
  return {
    symbol: symbolOf(l.ticker),
    fundingRate: perIntervalRate(num(l.funding_rate), l.funding_interval_s),
    fundingTimestamp: next,
    nextFundingTimestamp: next,
    intervalHours: l.funding_interval_s / 3_600,
  }
}
