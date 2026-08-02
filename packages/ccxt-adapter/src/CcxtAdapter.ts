import * as ccxt from 'ccxt'
import type {
  PerpExchangeAdapter,
  Ticker, Kline, OrderBook, MarketInfo,
  ExchangeBalance, ExchangePosition, ExchangeOrder, ExchangeTrade,
  FundingRateData, OpenInterestData, PerpOrderParams,
} from '@openwhaleorg/exchange'
import { RetryableAdapterError, TerminalAdapterError } from '@openwhaleorg/core'

/**
 * Generic PerpExchangeAdapter over any ccxt.pro exchange.
 *
 * One class covers every ccxt-supported venue:
 *
 *   new CcxtAdapter({ exchangeId: 'binance', apiKey, secret })
 *   new CcxtAdapter({ exchangeId: 'hyperliquid', walletAddress, privateKey })
 *
 * Venue quirks (e.g. Hyperliquid's market-order reference price) live in thin
 * subclasses that override only what differs — see @openwhaleorg/hyperliquid.
 *
 * Implementation conventions carried here so subclasses inherit them:
 * - watch* loops exit promptly when the AbortSignal fires; the orphaned ccxt
 *   promise stays handled (no unhandled rejections)
 * - ccxt errors are translated into the core error taxonomy: NetworkError →
 *   RetryableAdapterError, ExchangeError → TerminalAdapterError; BaseExecutor
 *   uses this to decide whether retrying is safe
 * - mapped types carry the raw venue payload in `info`
 */

export interface CcxtAdapterOptions {
  /** ccxt exchange id, e.g. 'binance', 'hyperliquid', 'bybit'. */
  exchangeId: string
  apiKey?: string
  secret?: string
  password?: string
  /** Wallet-based venues (Hyperliquid, dYdX…). */
  walletAddress?: string
  privateKey?: string
  /** Use the venue's sandbox/testnet. Default: false. */
  testnet?: boolean
  /**
   * Minimum spacing between requests, ms — ccxt's client-side throttle.
   *
   * **0 disables it entirely**: requests go out when the caller asks, not when
   * a queue lets them.
   *
   * ccxt's per-venue default (50ms ≈ 20 req/s) is a blanket figure that sits
   * BELOW what venues actually allow — Binance USD-M publishes 300 orders per
   * 10s (30/s) and 1200/min. For timed work the throttle is worse than slow:
   * it ignores the caller's schedule, so a ladder spread across 35 seconds
   * gets re-serialised into one 11.4s queue and its orders reach the venue
   * after the moment they were planned for.
   *
   * With it off, staying inside the venue's limits becomes the caller's job —
   * which is the right place for it, since only the caller knows the orders
   * are already spread over a minute.
   */
  rateLimitMs?: number
  /** Additional raw ccxt constructor options. */
  ccxtOptions?: Record<string, unknown>
}

const MARKET_TYPES: MarketInfo['type'][] = ['spot', 'swap', 'future', 'option']

export class CcxtAdapter implements PerpExchangeAdapter {
  protected readonly exchange: ccxt.Exchange

  constructor(options: CcxtAdapterOptions) {
    // ccxt.pro holds the WebSocket-capable constructors; typed as the base Exchange
    const Ctor = (ccxt.pro as unknown as Record<string, new (opts: Record<string, unknown>) => ccxt.Exchange>)[options.exchangeId]
    if (!Ctor) throw new TerminalAdapterError(`Unknown ccxt exchange id: "${options.exchangeId}"`)

    const opts: Record<string, unknown> = { enableRateLimit: true, ...options.ccxtOptions }
    // After the spread so an explicit setting wins over a raw ccxtOptions one
    if (options.rateLimitMs === 0) opts.enableRateLimit = false   // no client-side queue at all
    else if (options.rateLimitMs !== undefined && options.rateLimitMs > 0) opts.rateLimit = options.rateLimitMs
    if (options.apiKey) opts.apiKey = options.apiKey
    if (options.secret) opts.secret = options.secret
    if (options.password) opts.password = options.password
    if (options.walletAddress) opts.walletAddress = options.walletAddress
    if (options.privateKey) opts.privateKey = options.privateKey

    this.exchange = new Ctor(opts)
    if (options.testnet) this.exchange.setSandboxMode(true)
    // Symbol-less fetchOpenOrders is a deliberate adapter capability (the
    // account detail view wants ALL open orders); ccxt otherwise throws a
    // warning-as-error about the heavier rate-limit weight — acknowledged.
    ;(this.exchange.options as Record<string, unknown>)['warnOnFetchOpenOrdersWithoutSymbol'] = false
  }

  // ── Error translation ────────────────────────────────────────────────────────

  /**
   * Run a ccxt call, translating its errors into the core taxonomy.
   * Transport-level failures are retryable; venue rejections are terminal.
   */
  protected async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof ccxt.NetworkError) {
        throw new RetryableAdapterError(`${err.constructor.name}: ${err.message}`, { cause: err })
      }
      if (err instanceof ccxt.ExchangeError) {
        throw new TerminalAdapterError(`${err.constructor.name}: ${err.message}`, { cause: err })
      }
      throw err
    }
  }

  // ── Market data ─────────────────────────────────────────────────────────────

  async fetchTicker(symbol: string): Promise<Ticker> {
    const t = await this.guard(() => this.exchange.fetchTicker(symbol))
    return this.mapTicker(t)
  }

  async fetchOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
    const ob = await this.guard(() => this.exchange.fetchOrderBook(symbol, depth))
    return {
      symbol,
      timestamp: ob.timestamp ?? Date.now(),
      bids: ob.bids as [number, number][],
      asks: ob.asks as [number, number][],
    }
  }

  async fetchOHLCV(symbol: string, timeframe: string, limit = 100, since?: number): Promise<Kline[]> {
    const rows = await this.guard(() => this.exchange.fetchOHLCV(symbol, timeframe, since, limit))
    return rows.map((row) => ({
      timestamp: row[0] ?? 0,
      open: row[1] ?? 0,
      high: row[2] ?? 0,
      low: row[3] ?? 0,
      close: row[4] ?? 0,
      volume: row[5] ?? 0,
    }))
  }

  async fetchTrades(symbol: string, limit = 50): Promise<ExchangeTrade[]> {
    const trades = await this.guard(() => this.exchange.fetchTrades(symbol, undefined, limit))
    return trades.map(this.mapTrade)
  }

  /**
   * The venue's market catalogue. ccxt caches loadMarkets() on the exchange
   * instance, so repeat calls are local after the first.
   *
   * Markets missing base/quote (ccxt occasionally emits partial entries for
   * exotic listings) are dropped rather than surfaced as blanks in a picker.
   */
  async fetchMarkets(): Promise<MarketInfo[]> {
    await this.guard(() => this.exchange.loadMarkets())
    const out: MarketInfo[] = []
    for (const market of Object.values(this.exchange.markets)) {
      if (!market?.symbol || !market.base || !market.quote) continue
      out.push({
        symbol: market.symbol,
        base: market.base,
        quote: market.quote,
        ...(Array.isArray((market.info as Record<string, unknown> | undefined)?.['underlyingSubType'])
          ? { tags: (market.info as { underlyingSubType: string[] }).underlyingSubType } : {}),
        type: MARKET_TYPES.includes(market.type as MarketInfo['type']) ? market.type as MarketInfo['type'] : 'other',
        active: market.active !== false,
        ...(market.settle ? { settle: market.settle } : {}),
      })
    }
    return out
  }

  // ── Account ─────────────────────────────────────────────────────────────────

  async fetchBalance(): Promise<ExchangeBalance[]> {
    const bal = await this.guard(() => this.exchange.fetchBalance())
    const free = bal.free as unknown as Record<string, number> | undefined
    const used = bal.used as unknown as Record<string, number> | undefined
    const total = bal.total as unknown as Record<string, number> | undefined
    return Object.entries(total ?? {})
      .filter(([, v]) => v > 0)
      .map(([currency, v]) => ({
        currency,
        free: free?.[currency] ?? 0,
        used: used?.[currency] ?? 0,
        total: v,
      }))
  }

  async fetchOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    const orders = await this.guard(() => this.exchange.fetchOpenOrders(symbol))
    return orders.map(this.mapOrder)
  }

  async fetchOrders(symbol?: string, limit = 50): Promise<ExchangeOrder[]> {
    const orders = await this.guard(() => this.exchange.fetchOrders(symbol, undefined, limit))
    return orders.map(this.mapOrder)
  }

  async fetchOrder(orderId: string, symbol: string): Promise<ExchangeOrder> {
    const order = await this.guard(() => this.exchange.fetchOrder(orderId, symbol))
    return this.mapOrder(order)
  }

  async fetchOrderByClientId(clientOrderId: string, symbol: string): Promise<ExchangeOrder | undefined> {
    try {
      // ccxt unified: id=undefined + params.clientOrderId (binance maps to origClientOrderId)
      const order = await this.exchange.fetchOrder(undefined as never, symbol, { clientOrderId })
      return order ? this.mapOrder(order) : undefined
    } catch (err) {
      // "no such order" is a definitive negative — the id never reached the venue
      if (err instanceof ccxt.OrderNotFound) return undefined
      if (err instanceof ccxt.NetworkError) throw new RetryableAdapterError(`${err.constructor.name}: ${err.message}`, { cause: err })
      if (err instanceof ccxt.ExchangeError) throw new TerminalAdapterError(`${err.constructor.name}: ${err.message}`, { cause: err })
      throw err
    }
  }

  async fetchMyTrades(symbol?: string, limit = 50): Promise<ExchangeTrade[]> {
    const trades = await this.guard(() => this.exchange.fetchMyTrades(symbol, undefined, limit))
    return trades.map(this.mapTrade)
  }

  // ── Trading ─────────────────────────────────────────────────────────────────

  /** Dual-side (hedge-mode) venues accept positionSide on orders. ccxt models this as setPositionMode support. */
  get supportsPositionSide(): boolean {
    return this.exchange.has['setPositionMode'] === true
  }

  /**
   * The account's ACTUAL position mode, not the venue's capability.
   *
   * A Binance account sits in one-way mode by default even though the venue
   * offers hedge mode, and there positionSide is rejected while an
   * opposite-side order nets against the existing position instead of opening
   * beside it. Callers that place directional orders must know which world
   * they are in; `supportsPositionSide` alone cannot tell them.
   */
  /** Retune ccxt's throttle on the live instance; 0 switches it off. */
  setRateLimit(ms: number): void {
    if (ms <= 0) {
      this.exchange.enableRateLimit = false
      return
    }
    this.exchange.enableRateLimit = true
    this.exchange.rateLimit = ms
  }

  async fetchPositionMode(symbol?: string): Promise<{ hedged: boolean }> {
    if (!this.exchange.has['fetchPositionMode']) return { hedged: false }
    const mode = await this.guard(() => this.exchange.fetchPositionMode(symbol))
    return { hedged: (mode as { hedged?: boolean }).hedged === true }
  }

  async createOrder(params: PerpOrderParams): Promise<ExchangeOrder> {
    const extra: Record<string, unknown> = { ...(params.params ?? {}) }
    if (params.reduceOnly !== undefined) extra.reduceOnly = params.reduceOnly
    if (params.timeInForce !== undefined) extra.timeInForce = params.timeInForce
    if (params.clientOrderId !== undefined) extra.clientOrderId = params.clientOrderId
    if (params.positionSide !== undefined && this.supportsPositionSide) {
      extra.positionSide = params.positionSide.toUpperCase()
      // In hedge mode the side already encodes open/close intent; Binance
      // rejects an explicit reduceOnly alongside positionSide.
      delete extra.reduceOnly
    }
    // ccxt v4's unified trigger field. Venues map it to their own stop family
    // (Binance STOP_MARKET, Hyperliquid trigger orders); a venue without stop
    // support raises, which callers must treat as "no stop available".
    if (params.triggerPrice !== undefined) extra.triggerPrice = params.triggerPrice

    // Binance portfolio margin moved conditional orders off
    // /papi/v1/um/conditional/* on 2026-04-28; every ccxt through 4.5.70 still
    // posts there and gets an HTML 404 back. Until ccxt catches up, place the
    // stop on the replacement endpoint ourselves. Verified live: the old
    // family 404s, POST um/algo/order exists (GET answers 405, not 404).
    if (params.triggerPrice !== undefined && this.exchange.options['portfolioMargin'] === true
        && String(this.exchange.id).startsWith('binance')) {
      const market = this.exchange.market(params.symbol)
      // Shape verified live against the endpoint itself (2026-08-01), the
      // venue dictating each field through its own errors:
      //   algoType MUST be 'CONDITIONAL'            (-4500 otherwise)
      //   the trigger field is 'triggerPrice'        (-1102 until renamed)
      //   positionSide LONG/SHORT is MANDATORY       (-4061 on BOTH/absent)
      //   reduceOnly is REJECTED alongside it        (-1106) — positionSide
      //     scoping is the reduce guarantee: a triggered close on an empty
      //     side cannot flip, it just has nothing to do
      //   the client id lane is 'clientAlgoId'; the response id is 'algoId'
      // A full place→cancel roundtrip returned {"complete":true}.
      const request: Record<string, unknown> = {
        symbol: market['id'],
        side: params.side.toUpperCase(),
        algoType: 'CONDITIONAL',
        type: params.type === 'limit' ? 'STOP' : 'STOP_MARKET',
        quantity: this.exchange.amountToPrecision(params.symbol, params.amount),
        triggerPrice: this.exchange.priceToPrecision(params.symbol, params.triggerPrice),
        ...(params.type === 'limit' && params.price !== undefined
          ? { price: this.exchange.priceToPrecision(params.symbol, params.price) } : {}),
        // A stop CLOSES a position: a SELL stop protects the LONG side.
        positionSide: (extra.positionSide as string | undefined)
          ?? (params.side === 'sell' ? 'LONG' : 'SHORT'),
        ...(params.clientOrderId !== undefined ? { clientAlgoId: params.clientOrderId } : {}),
      }
      const resp = await this.guard(() => (this.exchange as unknown as {
        request: (path: string, api: string, method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>
      }).request('um/algo/order', 'papi', 'POST', request))
      return {
        id: String(resp['algoId'] ?? resp['strategyId'] ?? ''),
        symbol: params.symbol,
        type: params.type,
        side: params.side,
        price: params.triggerPrice,
        amount: params.amount,
        filled: 0,
        remaining: params.amount,
        status: 'open',
        timestamp: Number(resp['bookTime'] ?? Date.now()),
        reduceOnly: params.reduceOnly ?? true,
        timeInForce: params.timeInForce ?? 'GTC',
      }
    }

    const order = await this.guard(() => this.exchange.createOrder(
      params.symbol,
      params.type,
      params.side,
      params.amount,
      params.price,
      extra,
    ))
    return this.mapOrder(order)
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    await this.guard(() => this.exchange.cancelOrder(orderId, symbol))
  }

  async cancelAllOrders(symbol?: string): Promise<void> {
    if (this.exchange.has['cancelAllOrders']) {
      await this.guard(() => this.exchange.cancelAllOrders(symbol))
      return
    }
    // Fall back to canceling one by one
    const orders = await this.fetchOpenOrders(symbol)
    await Promise.all(orders.map(o => this.cancelOrder(o.id, o.symbol)))
  }

  async amountToPrecision(symbol: string, amount: number): Promise<number> {
    await this.guard(() => this.exchange.loadMarkets())
    return Number(this.exchange.amountToPrecision(symbol, amount))
  }

  async priceToPrecision(symbol: string, price: number): Promise<number> {
    await this.guard(() => this.exchange.loadMarkets())
    return Number(this.exchange.priceToPrecision(symbol, price))
  }

  // ── Perp-specific ────────────────────────────────────────────────────────────

  async fetchFundingRate(symbol: string): Promise<FundingRateData> {
    if (this.exchange.has['fetchFundingRate']) {
      const r = await this.guard(() => this.exchange.fetchFundingRate(symbol))
      return this.mapFundingRate(r)
    }
    const rates = await this.fetchFundingRates()
    const rate = rates.find(r => r.symbol === symbol)
    if (!rate) throw new TerminalAdapterError(`Funding rate not found for ${symbol}`)
    return rate
  }

  async fetchFundingRates(): Promise<FundingRateData[]> {
    const rates = await this.guard(() => this.exchange.fetchFundingRates())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Object.values(rates).map((r: any) => this.mapFundingRate(r))
  }

  /**
   * Settlement periods per symbol. Only venues with a dedicated endpoint
   * support this — Binance does (8h/4h/1h vary per contract); Hyperliquid
   * instead states the interval on each funding rate.
   */
  async fetchFundingIntervals(): Promise<Record<string, number>> {
    if (!this.exchange.has['fetchFundingIntervals']) return {}
    const intervals = await this.guard(() => this.exchange.fetchFundingIntervals())
    const out: Record<string, number> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const entry of Object.values(intervals) as any[]) {
      const hours = parseIntervalHours(entry?.interval)
      if (entry?.symbol && hours) out[entry.symbol] = hours
    }
    return out
  }

  async fetchOpenInterest(symbol: string): Promise<OpenInterestData> {
    const oi = await this.guard(() => this.exchange.fetchOpenInterest(symbol))
    return {
      symbol: oi.symbol ?? symbol,
      timestamp: oi.timestamp ?? Date.now(),
      amount: oi.openInterestAmount ?? oi.baseVolume ?? 0,
      ...(oi.openInterestValue !== undefined ? { value: oi.openInterestValue } : {}),
    }
  }

  /**
   * Leverage brackets for one contract, ascending by notional cap. Venues
   * with a tier API (binance …) map through ccxt; others degrade to a single
   * bracket from market.limits.leverage.max (Infinity cap).
   */
  async fetchLeverageTiers(symbol: string): Promise<Array<{ maxNotionalUsd: number; maxLeverage: number }>> {
    if (this.exchange.has['fetchLeverageTiers']) {
      const tiers = await this.guard(() => this.exchange.fetchLeverageTiers([symbol]))
      const rows = (tiers as Record<string, Array<{ maxNotional?: number; maxLeverage?: number }>>)[symbol] ?? []
      const mapped = rows
        .filter(r => r.maxLeverage !== undefined)
        .map(r => ({ maxNotionalUsd: r.maxNotional ?? Infinity, maxLeverage: r.maxLeverage! }))
        .sort((a, b) => a.maxNotionalUsd - b.maxNotionalUsd)
      if (mapped.length > 0) return mapped
    }
    await this.guard(() => this.exchange.loadMarkets())
    const max = this.exchange.market(symbol)?.limits?.leverage?.max
    return [{ maxNotionalUsd: Infinity, maxLeverage: typeof max === 'number' && max > 0 ? max : 1 }]
  }

  async fetchPositions(symbols?: string[]): Promise<ExchangePosition[]> {
    const positions = await this.guard(() => this.exchange.fetchPositions(symbols))
    return positions.map(this.mapPosition)
  }

  async fetchPosition(symbol: string): Promise<ExchangePosition> {
    const pos = await this.guard(() => this.exchange.fetchPosition(symbol))
    return this.mapPosition(pos)
  }

  async setLeverage(symbol: string, leverage: number, params?: Record<string, unknown>): Promise<void> {
    await this.guard(() => this.exchange.setLeverage(leverage, symbol, params))
  }

  async setMarginMode(symbol: string, marginMode: 'cross' | 'isolated', params?: Record<string, unknown>): Promise<void> {
    await this.guard(() => this.exchange.setMarginMode(marginMode, symbol, params))
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────

  /**
   * Await a ccxt watch promise, resolving null if the signal aborts first.
   * The orphaned watch promise stays handled either way, so a late rejection
   * after abort can't become an unhandled rejection.
   */
  protected raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T | null> {
    if (!signal) return promise
    return new Promise<T | null>((resolve, reject) => {
      const onAbort = () => resolve(null)
      if (signal.aborted) {
        promise.catch(() => undefined)
        return resolve(null)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        v => { signal.removeEventListener('abort', onAbort); resolve(v) },
        e => { signal.removeEventListener('abort', onAbort); if (signal.aborted) resolve(null); else reject(e) },
      )
    })
  }

  async watchTicker(symbol: string, callback: (ticker: Ticker) => void, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const t = await this.raceAbort(this.exchange.watchTicker(symbol), signal)
      if (t === null) return
      callback(this.mapTicker(t))
    }
  }

  async watchTrades(symbol: string, callback: (trades: ExchangeTrade[]) => void, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const trades = await this.raceAbort(this.exchange.watchTrades(symbol), signal)
      if (trades === null) return
      callback(trades.map(this.mapTrade))
    }
  }

  async watchOrderBook(symbol: string, callback: (ob: OrderBook) => void, depth = 20, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const ob = await this.raceAbort(this.exchange.watchOrderBook(symbol, depth), signal)
      if (ob === null) return
      callback({
        symbol,
        timestamp: ob.timestamp ?? Date.now(),
        bids: ob.bids as [number, number][],
        asks: ob.asks as [number, number][],
      })
    }
  }

  async watchMyTrades(callback: (trades: ExchangeTrade[]) => void, params?: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const trades = await this.raceAbort(this.exchange.watchMyTrades(undefined, undefined, undefined, params), signal)
      if (trades === null) return
      callback(trades.map(this.mapTrade))
    }
  }

  async watchOrders(symbol: string | undefined, callback: (orders: ExchangeOrder[]) => void, signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      const orders = await this.raceAbort(this.exchange.watchOrders(symbol), signal)
      if (orders === null) return
      callback(orders.map(this.mapOrder))
    }
  }

  async close(): Promise<void> {
    await this.exchange.close()
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────
  // Arrow properties: these are passed unbound to Array.map

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly mapTicker = (t: any): Ticker => ({
    symbol: t.symbol,
    timestamp: t.timestamp ?? Date.now(),
    last: t.last ?? 0,
    bid: t.bid ?? 0,
    ask: t.ask ?? 0,
    high: t.high ?? 0,
    low: t.low ?? 0,
    volume: t.baseVolume ?? 0,
    quoteVolume: t.quoteVolume ?? 0,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly mapTrade = (t: any): ExchangeTrade => {
    const trade: ExchangeTrade = {
      id: t.id ?? '',
      symbol: t.symbol ?? '',
      side: t.side,
      price: t.price ?? 0,
      amount: t.amount ?? 0,
      cost: t.cost ?? 0,
      timestamp: t.timestamp ?? Date.now(),
      takerOrMaker: t.takerOrMaker ?? 'taker',
      info: t.info,
    }
    if (t.fee) trade.fee = { cost: t.fee.cost ?? 0, currency: t.fee.currency ?? '' }
    return trade
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly mapOrder = (o: any): ExchangeOrder => {
    const order: ExchangeOrder = {
      id: o.id ?? '',
      symbol: o.symbol ?? '',
      type: o.type ?? 'market',
      side: o.side,
      price: o.price ?? 0,
      amount: o.amount ?? 0,
      filled: o.filled ?? 0,
      remaining: o.remaining ?? 0,
      status: o.status ?? 'open',
      timestamp: o.timestamp ?? Date.now(),
      reduceOnly: o.reduceOnly ?? false,
      timeInForce: o.timeInForce ?? 'GTC',
      info: o.info,
    }
    if (o.average != null) order.average = o.average
    if (o.fee) order.fee = { cost: o.fee.cost ?? 0, currency: o.fee.currency ?? '' }
    return order
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly mapPosition = (p: any): ExchangePosition => {
    const position: ExchangePosition = {
      symbol: p.symbol ?? '',
      side: p.side ?? 'long',
      contracts: p.contracts ?? 0,
      contractSize: p.contractSize ?? 1,
      entryPrice: p.entryPrice ?? 0,
      markPrice: p.markPrice ?? 0,
      notional: p.notional ?? 0,
      unrealizedPnl: p.unrealizedPnl ?? 0,
      leverage: p.leverage ?? 1,
      marginMode: p.marginMode ?? 'cross',
      initialMargin: p.initialMargin ?? 0,
      maintenanceMargin: p.maintenanceMargin ?? 0,
      info: p.info,
    }
    if (p.liquidationPrice != null) position.liquidationPrice = p.liquidationPrice
    return position
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected readonly mapFundingRate = (r: any): FundingRateData => ({
    symbol: r.symbol,
    fundingRate: r.fundingRate ?? 0,
    fundingTimestamp: r.fundingTimestamp ?? 0,
    // ccxt convention: `fundingTimestamp` is the UPCOMING settlement; most
    // venues never populate nextFundingTimestamp. Fall back so consumers can
    // rely on nextFundingTimestamp being the next settlement instant.
    nextFundingTimestamp: r.nextFundingTimestamp ?? r.fundingTimestamp ?? 0,
    ...(parseIntervalHours(r.interval) ? { intervalHours: parseIntervalHours(r.interval)! } : {}),
  })
}

/** Parse a ccxt funding interval label ('8h', '4h', '1h', '30m') into hours. */
function parseIntervalHours(interval: unknown): number | undefined {
  if (typeof interval !== 'string') return undefined
  const match = /^(\d+(?:\.\d+)?)(h|m)$/.exec(interval.trim())
  if (!match) return undefined
  const value = Number(match[1])
  return match[2] === 'h' ? value : value / 60
}
