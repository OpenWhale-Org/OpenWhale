import { TerminalAdapterError } from '@openwhaleorg/core'
import type {
  ExchangeBalance, ExchangeFill, ExchangeOrder, ExchangePosition, ExchangeTrade,
  FundingRateData, Kline, LeverageTier, MarketInfo, OpenInterestData, OrderBook,
  PerpExchangeAdapter, PerpOrderParams, Ticker,
} from '@openwhaleorg/exchange'
import { CrossExClient, type CrossExClientOptions } from './client.js'
import { parseCrossExSymbol, roundToStep, ruleToMarket, underlyingSymbol, underlyingVenue, type CrossExRule } from './symbols.js'

/**
 * Gate CrossEx — one account, many exchanges, one margin pool.
 *
 * Orders, positions and collateral for Binance, OKX, Bybit, Gate, Kraken,
 * Hyperliquid and Deribit all travel through this one adapter, because on
 * CrossEx they really are one account: margin is shared, and a hedge whose
 * legs sit on two exchanges needs no transfer between them. The exchange is
 * named IN the symbol (`BINANCE_SWAP_BTC_USDT`), never in the venue.
 *
 * What CrossEx does NOT serve is public market depth: its REST exposes
 * tickers and funding only — no book, no candles, no public trades. Those
 * methods fail loudly here and point at the underlying venue's own adapter,
 * which lists the same market and needs no key. (Its public WebSocket does
 * carry a book; wiring that is the follow-up.)
 *
 * There is no CrossEx testnet. Every order placed through this is real.
 */
export class CrossExAdapter implements PerpExchangeAdapter {
  readonly supportsPositionSide = true

  protected readonly client: CrossExClient
  /** Trading rules by symbol, from `/crossex/rule/symbols`. */
  private rules = new Map<string, CrossExRule>()
  private rulesLoadedAt = 0

  constructor(options: CrossExClientOptions = {}) {
    this.client = new CrossExClient(options)
  }

  // ── Instruments ───────────────────────────────────────────────────────────

  async fetchMarkets(): Promise<MarketInfo[]> {
    return (await this.loadRules()).map(ruleToMarket)
  }

  /**
   * The rule rows, cached for a minute.
   *
   * They are the runtime source of truth for what exists and at what
   * precision — a listing appearing or a tick size changing must not need a
   * restart — but every order rounds against them, so they cannot be fetched
   * per call either.
   */
  private async loadRules(force = false): Promise<CrossExRule[]> {
    const fresh = Date.now() - this.rulesLoadedAt < 60_000
    if (!force && fresh && this.rules.size > 0) return [...this.rules.values()]
    const rows = await this.client.get<CrossExRule[]>('/crossex/rule/symbols')
    this.rules = new Map(rows.map(row => [row.symbol, row]))
    this.rulesLoadedAt = Date.now()
    return rows
  }

  private async ruleFor(symbol: string): Promise<CrossExRule> {
    if (!this.rules.has(symbol)) await this.loadRules(true)
    const rule = this.rules.get(symbol)
    if (!rule) {
      const hint = parseCrossExSymbol(symbol)
        ? 'it is not listed on this account'
        : 'CrossEx symbols look like BINANCE_SWAP_BTC_USDT (exchange_business_base_quote)'
      throw new TerminalAdapterError(`CrossEx does not list "${symbol}" — ${hint}.`)
    }
    return rule
  }

  async amountToPrecision(symbol: string, amount: number): Promise<number> {
    return roundToStep(amount, Number((await this.ruleFor(symbol)).lot_size))
  }

  async priceToPrecision(symbol: string, price: number): Promise<number> {
    return roundToStep(price, Number((await this.ruleFor(symbol)).tick_size), 'nearest')
  }

  /**
   * CrossEx quantities are in base units even where the underlying venue
   * counts contracts, so this is the identity — with the rule's contract_size
   * consulted rather than assumed, in case a venue is ever added that is not.
   */
  async baseAmountToContracts(symbol: string, baseAmount: number): Promise<number> {
    const size = Number((await this.ruleFor(symbol)).contract_size)
    return size > 0 && size !== 1 ? baseAmount / size : baseAmount
  }

  // ── Market data ───────────────────────────────────────────────────────────

  async fetchTicker(symbol: string): Promise<Ticker> {
    const [row] = await this.client.get<CrossExTicker[]>('/crossex/market/tickers', { symbols: symbol })
    if (!row) throw new TerminalAdapterError(`CrossEx has no ticker for "${symbol}".`)
    return toTicker(row)
  }

  async fetchTickers(): Promise<Ticker[]> {
    return (await this.client.get<CrossExTicker[]>('/crossex/market/tickers')).map(toTicker)
  }

  async fetchFundingRate(symbol: string): Promise<FundingRateData> {
    const [row] = await this.client.get<CrossExFunding[]>('/crossex/market/funding_info', { symbols: symbol })
    if (!row) throw new TerminalAdapterError(`CrossEx has no funding info for "${symbol}".`)
    return toFundingRate(row)
  }

  async fetchFundingRates(): Promise<FundingRateData[]> {
    return (await this.client.get<CrossExFunding[]>('/crossex/market/funding_info')).map(toFundingRate)
  }

  async fetchFundingIntervals(): Promise<Record<string, number>> {
    const rows = await this.client.get<CrossExFunding[]>('/crossex/market/funding_info')
    const out: Record<string, number> = {}
    for (const row of rows) {
      const hours = intervalHours(row)
      if (hours !== undefined) out[row.symbol] = hours
    }
    return out
  }

  async fetchOpenInterest(symbol: string): Promise<OpenInterestData> {
    const [row] = await this.client.get<CrossExTicker[]>('/crossex/market/tickers', { symbols: symbol })
    if (!row) throw new TerminalAdapterError(`CrossEx has no ticker for "${symbol}".`)
    return { symbol, timestamp: Number(row.timestamp) || Date.now(), amount: Number(row.open_interest) || 0 }
  }

  /** Risk tiers, ascending: the max leverage allowed at each notional band. */
  async fetchLeverageTiers(symbol: string): Promise<LeverageTier[]> {
    const [row] = await this.client.get<CrossExRiskLimit[]>('/crossex/rule/risk_limits', { symbols: symbol })
    return (row?.tiers ?? [])
      .map(tier => ({
        maxNotionalUsd: Number(tier.max_risk_limit_value) || Infinity,
        maxLeverage: Number(tier.leverage_max) || 0,
      }))
      .sort((a, b) => a.maxNotionalUsd - b.maxNotionalUsd)
  }

  fetchOrderBook(symbol: string, _depth?: number): Promise<OrderBook> {
    return Promise.reject(this.noPublicDepth('an order book', symbol))
  }

  fetchOHLCV(symbol: string, _timeframe: string, _limit?: number, _since?: number): Promise<Kline[]> {
    return Promise.reject(this.noPublicDepth('candles', symbol))
  }

  fetchTrades(symbol: string, _limit?: number): Promise<ExchangeTrade[]> {
    return Promise.reject(this.noPublicDepth('a public trade tape', symbol))
  }

  /**
   * The same market is listed on its own exchange, where this data is public
   * and keyless — so the error names that route instead of merely refusing.
   */
  private noPublicDepth(what: string, symbol: string): TerminalAdapterError {
    const venue = underlyingVenue(symbol)
    const native = underlyingSymbol(symbol)
    const route = venue && native
      ? ` Read it from the venue itself: ${venue}:${native}.`
      : ''
    return new TerminalAdapterError(`CrossEx REST does not serve ${what}.${route}`)
  }

  // ── Account ───────────────────────────────────────────────────────────────

  async fetchBalance(): Promise<ExchangeBalance[]> {
    const account = await this.client.getPrivate<CrossExAccount>('/crossex/accounts')
    return (account.assets ?? [])
      .map(asset => ({
        currency: asset.coin,
        free: Number(asset.available) || 0,
        used: Math.max(0, (Number(asset.total) || 0) - (Number(asset.available) || 0)),
        total: Number(asset.total) || 0,
      }))
      .filter(balance => balance.total !== 0)
  }

  /**
   * The number that actually governs a CrossEx account.
   *
   * Balances alone read it wrong: collateral sits in several assets at a
   * haircut, and one currency's wallet can be negative while the account is
   * healthy. The venue publishes the pooled figures, so they are reported as
   * they are given rather than summed here.
   */
  async fetchPortfolioEquity(): Promise<{ equityUsd: number; availableUsd: number } | null> {
    const account = await this.client.getPrivate<CrossExAccount>('/crossex/accounts')
    const equity = Number(account.total_equity ?? account.equity)
    const available = Number(account.available_balance ?? account.available)
    if (!Number.isFinite(equity)) return null
    return { equityUsd: equity, availableUsd: Number.isFinite(available) ? Math.max(0, available) : 0 }
  }

  async fetchPositions(symbols?: string[]): Promise<ExchangePosition[]> {
    const rows = await this.client.getPrivate<CrossExPosition[]>('/crossex/positions')
    const wanted = symbols && symbols.length > 0 ? new Set(symbols) : undefined
    return rows
      .filter(row => !wanted || wanted.has(row.symbol))
      .map(toPosition)
  }

  async fetchPosition(symbol: string): Promise<ExchangePosition> {
    const [position] = await this.fetchPositions([symbol])
    return position ?? flatPosition(symbol)
  }

  /**
   * Hedge mode is an account-wide setting on CrossEx (`position_mode`), not a
   * per-symbol one; the symbol is accepted and ignored so callers stay generic.
   */
  async fetchPositionMode(_symbol?: string): Promise<{ hedged: boolean }> {
    const account = await this.client.getPrivate<CrossExAccount>('/crossex/accounts')
    return { hedged: (account.position_mode ?? '').toUpperCase() === 'DUAL' }
  }

  async fetchOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    const rows = await this.client.getPrivate<CrossExOrder[]>('/crossex/open_orders', symbol ? { symbol } : undefined)
    return rows.map(toOrder)
  }

  async fetchOrders(symbol?: string, limit = 100): Promise<ExchangeOrder[]> {
    const rows = await this.client.getPrivate<CrossExOrder[]>('/crossex/history_orders', {
      limit,
      ...(symbol ? { symbol } : {}),
    })
    return rows.map(toOrder)
  }

  async fetchOrder(orderId: string, _symbol: string): Promise<ExchangeOrder> {
    return toOrder(await this.client.getPrivate<CrossExOrder>(`/crossex/orders/${encodeURIComponent(orderId)}`))
  }

  /**
   * CrossEx looks an order up by client id on the same route as by order id,
   * so a retry can ask "did my order arrive?" and get an answer instead of a
   * duplicate.
   */
  async fetchOrderByClientId(clientOrderId: string, _symbol: string): Promise<ExchangeOrder | undefined> {
    try {
      return toOrder(await this.client.getPrivate<CrossExOrder>(`/crossex/orders/${encodeURIComponent(clientOrderId)}`))
    } catch (err) {
      // "Not found" is the answer, not a failure: the order never landed.
      if (String((err as Error).message).includes('→ 404')) return undefined
      throw err
    }
  }

  async fetchMyTrades(symbol?: string, limit = 100): Promise<ExchangeTrade[]> {
    const rows = await this.fetchTradeRows(symbol, limit)
    return rows.map(row => ({
      id: row.trade_id ?? row.id ?? '',
      symbol: row.symbol,
      side: row.side.toLowerCase() === 'buy' ? 'buy' : 'sell',
      price: Number(row.price) || 0,
      amount: Number(row.qty) || 0,
      cost: (Number(row.price) || 0) * (Number(row.qty) || 0),
      timestamp: Number(row.create_time) || 0,
      ...(row.fee !== undefined ? { fee: { cost: Number(row.fee) || 0, currency: row.fee_coin ?? '' } } : {}),
      takerOrMaker: (row.role ?? '').toLowerCase() === 'maker' ? 'maker' : 'taker',
      info: row,
    }))
  }

  /** The venue's own ledger of fills — what PnL attribution reconciles against. */
  async fetchFills(symbol: string, since?: number, limit = 200): Promise<ExchangeFill[]> {
    const rows = await this.fetchTradeRows(symbol, limit, since)
    return rows
      .map(row => ({
        id: row.trade_id ?? row.id ?? '',
        orderId: row.order_id ?? '',
        symbol: row.symbol,
        side: (row.side.toLowerCase() === 'buy' ? 'buy' : 'sell') as 'buy' | 'sell',
        qty: Number(row.qty) || 0,
        price: Number(row.price) || 0,
        ...(row.realized_pnl !== undefined ? { realizedPnl: Number(row.realized_pnl) || 0 } : {}),
        ...(row.fee !== undefined ? { fee: Number(row.fee) || 0 } : {}),
        ...(row.fee_coin !== undefined ? { feeAsset: row.fee_coin } : {}),
        timestamp: Number(row.create_time) || 0,
        info: row as unknown as Record<string, unknown>,
      }))
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  private fetchTradeRows(symbol?: string, limit = 100, since?: number): Promise<CrossExTradeRow[]> {
    return this.client.getPrivate<CrossExTradeRow[]>('/crossex/history_trades', {
      limit,
      ...(symbol ? { symbol } : {}),
      ...(since !== undefined ? { from: since } : {}),
    })
  }

  // ── Trading ───────────────────────────────────────────────────────────────

  async createOrder(params: PerpOrderParams): Promise<ExchangeOrder> {
    if (params.triggerPrice !== undefined) {
      throw new TerminalAdapterError('CrossEx has no trigger orders on this route — place the order when the trigger is reached.')
    }
    const type = params.type === 'market' ? 'MARKET' : 'LIMIT'
    if (type === 'LIMIT' && params.price === undefined) {
      throw new TerminalAdapterError('CrossEx limit orders need a price.')
    }
    const body: Record<string, unknown> = {
      symbol: params.symbol,
      side: params.side.toUpperCase(),
      type,
      qty: String(params.amount),
      ...(params.price !== undefined ? { price: String(params.price) } : {}),
      ...(params.clientOrderId ? { text: params.clientOrderId } : {}),
      ...(params.reduceOnly ? { reduce_only: 'true' } : {}),
      ...(params.timeInForce ? { time_in_force: params.timeInForce === 'PO' ? 'POC' : params.timeInForce } : {}),
      ...(params.positionSide ? { position_side: params.positionSide.toUpperCase() } : {}),
      ...(params.params ?? {}),
    }
    const created = await this.client.post<CrossExOrder>('/crossex/orders', body, { order: true })
    // The create response is thin on some venues; the order read is the one
    // that carries state and fills, and callers reconcile against it.
    return toOrder({ ...created, symbol: created.symbol ?? params.symbol })
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<void> {
    await this.client.delete(`/crossex/orders/${encodeURIComponent(orderId)}`)
  }

  /**
   * One batch call, not a loop.
   *
   * Cancelling ladder by ladder leaves the account exposed between calls, and
   * the venue's own batch route reports per-order acceptance — which is what
   * gets checked here, since a 200 with every order rejected is still a
   * failure to cancel.
   */
  async cancelAllOrders(symbol?: string): Promise<void> {
    const open = await this.fetchOpenOrders(symbol)
    if (open.length === 0) return
    const results = await this.client.post<CrossExBatchCancelResult[]>(
      '/crossex/batch_cancel_orders',
      open.map(order => ({ order_id: order.id })),
    )
    const refused = (results ?? []).filter(result => String(result.accepted) !== 'true')
    if (refused.length === results?.length && refused.length > 0) {
      const first = refused[0]!
      throw new TerminalAdapterError(`CrossEx refused every cancel: ${first.label ?? ''} ${first.message ?? ''}`.trim())
    }
  }

  async setLeverage(symbol: string, leverage: number, _params?: Record<string, unknown>): Promise<void> {
    await this.client.post('/crossex/positions/leverage', { symbol, leverage: String(leverage) })
  }

  /**
   * CrossEx has no per-symbol margin mode: the account is cross by
   * construction — that shared pool is the product. Asking for isolated is a
   * caller's assumption worth failing on rather than silently ignoring.
   */
  setMarginMode(symbol: string, marginMode: 'cross' | 'isolated'): Promise<void> {
    if (marginMode === 'cross') return Promise.resolve()
    return Promise.reject(new TerminalAdapterError(
      `CrossEx accounts share one margin pool across exchanges; "${symbol}" cannot be isolated.`,
    ))
  }

  /** Close the whole position in one call — the venue's own route, rate-limited to 100/day. */
  async closePosition(symbol: string, positionSide?: 'long' | 'short'): Promise<void> {
    await this.client.post('/crossex/position', {
      symbol,
      ...(positionSide ? { position_side: positionSide.toUpperCase() } : {}),
    })
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────
  //
  // CrossEx publishes both streams (client.ts names them), but nothing here
  // speaks them yet. Refusing is the honest state: a watch that resolved
  // immediately would read as "subscribed, venue is quiet" — the exact failure
  // the framework's first-frame watchdog exists to catch — while rejecting
  // makes a monitor fall back to REST polling on its next attempt.

  watchTicker(): Promise<void> { return Promise.reject(this.noStream('ticker')) }
  watchTrades(): Promise<void> { return Promise.reject(this.noStream('trade')) }
  watchOrderBook(): Promise<void> { return Promise.reject(this.noStream('order_book_update')) }
  watchMyTrades(): Promise<void> { return Promise.reject(this.noStream('usertrades')) }
  watchOrders(): Promise<void> { return Promise.reject(this.noStream('order')) }

  private noStream(channel: string): TerminalAdapterError {
    return new TerminalAdapterError(
      `CrossEx streaming is not wired yet (channel "${channel}"). Poll over REST for now.`,
    )
  }

  async close(): Promise<void> { /* REST only — nothing to tear down yet */ }
}

/** Market data only: symbols, tickers, funding, risk limits — no key needed. */
export class CrossExPublicAdapter extends CrossExAdapter {
  constructor(options: Omit<CrossExClientOptions, 'apiKey' | 'apiSecret'> = {}) {
    super(options)
  }
}

// ── Venue payloads ────────────────────────────────────────────────────────────

interface CrossExTicker {
  symbol: string
  last_price: string
  open_24h: string
  low_24h: string
  high_24h: string
  volume_24h_base: string
  volume_24h_quote: string
  mark_price: string
  index_price: string
  open_interest: string
  timestamp: string
}

interface CrossExFunding {
  symbol: string
  funding_rate: string
  funding_interval: string
  funding_time: string
}

interface CrossExRiskLimit {
  symbol: string
  tiers: Array<{
    min_risk_limit_value: string
    max_risk_limit_value: string
    leverage_max: string
    maintenance_rate: string
  }>
}

interface CrossExAccount {
  position_mode?: string
  account_mode?: string
  total_equity?: string
  equity?: string
  available_balance?: string
  available?: string
  assets?: Array<{ coin: string; total: string; available: string }>
}

interface CrossExPosition {
  symbol: string
  position_side: string
  position_qty: string
  position_value: string
  entry_price: string
  mark_price: string
  upnl: string
  leverage: string
  initial_margin: string
  maintenance_margin: string
  liq_price?: string
  funding_fee?: string
}

interface CrossExOrder {
  order_id: string
  text?: string
  symbol: string
  side: string
  type: string
  state: string
  qty: string
  price: string
  executed_qty: string
  executed_avg_price?: string
  time_in_force?: string
  reduce_only?: string
  fee?: string
  fee_coin?: string
  create_time?: string
}

interface CrossExBatchCancelResult {
  order_id: string
  text: string
  accepted: string
  label?: string
  message?: string
}

interface CrossExTradeRow {
  id?: string
  trade_id?: string
  order_id?: string
  symbol: string
  side: string
  qty: string
  price: string
  fee?: string
  fee_coin?: string
  role?: string
  realized_pnl?: string
  create_time?: string
}

// ── Mapping ───────────────────────────────────────────────────────────────────

/**
 * CrossEx tickers carry no best bid/ask — the book is not on this REST API.
 * They are reported as 0 rather than filled in from `last`: a caller that
 * reads a fabricated zero-width spread as tradable is worse off than one that
 * sees "not reported" and falls back to the last trade.
 */
function toTicker(row: CrossExTicker): Ticker {
  return {
    symbol: row.symbol,
    timestamp: Number(row.timestamp) || Date.now(),
    last: Number(row.last_price) || 0,
    bid: 0,
    ask: 0,
    high: Number(row.high_24h) || 0,
    low: Number(row.low_24h) || 0,
    volume: Number(row.volume_24h_base) || 0,
    quoteVolume: Number(row.volume_24h_quote) || 0,
  }
}

function intervalHours(row: CrossExFunding): number | undefined {
  const raw = Number(row.funding_interval)
  if (!Number.isFinite(raw) || raw <= 0) return undefined
  // The field is seconds on some venues and hours on others; anything large
  // enough to be a duration in seconds is read as one.
  return raw > 48 ? raw / 3600 : raw
}

function toFundingRate(row: CrossExFunding): FundingRateData {
  const next = Number(row.funding_time) || 0
  const hours = intervalHours(row)
  return {
    symbol: row.symbol,
    fundingRate: Number(row.funding_rate) || 0,
    fundingTimestamp: next,
    nextFundingTimestamp: next,
    ...(hours !== undefined ? { intervalHours: hours } : {}),
  }
}

function toPosition(row: CrossExPosition): ExchangePosition {
  const qty = Math.abs(Number(row.position_qty) || 0)
  const side = (row.position_side ?? '').toUpperCase() === 'SHORT' || Number(row.position_qty) < 0 ? 'short' : 'long'
  const liquidation = Number(row.liq_price)
  return {
    symbol: row.symbol,
    side,
    contracts: qty,
    contractSize: 1,
    entryPrice: Number(row.entry_price) || 0,
    markPrice: Number(row.mark_price) || 0,
    notional: Math.abs(Number(row.position_value) || 0),
    unrealizedPnl: Number(row.upnl) || 0,
    leverage: Number(row.leverage) || 0,
    ...(Number.isFinite(liquidation) && liquidation > 0 ? { liquidationPrice: liquidation } : {}),
    marginMode: 'cross',
    initialMargin: Number(row.initial_margin) || 0,
    maintenanceMargin: Number(row.maintenance_margin) || 0,
    info: row,
  }
}

function flatPosition(symbol: string): ExchangePosition {
  return {
    symbol, side: 'long', contracts: 0, contractSize: 1, entryPrice: 0, markPrice: 0,
    notional: 0, unrealizedPnl: 0, leverage: 0, marginMode: 'cross',
    initialMargin: 0, maintenanceMargin: 0,
  }
}

/** Venue order state → the generic lifecycle the framework reasons about. */
function orderStatus(state: string, filled: number, amount: number): ExchangeOrder['status'] {
  switch (state.toUpperCase()) {
    case 'NEW':
    case 'OPEN':
    case 'PARTIALLY_FILLED': return 'open'
    case 'FILLED':
    case 'CLOSED': return 'closed'
    case 'CANCELLED':
    case 'CANCELED': return 'canceled'
    case 'REJECTED': return 'rejected'
    case 'EXPIRED': return 'expired'
    // An unknown state is decided by the fills rather than assumed open: a
    // fully filled order reported as open would be re-placed by a caller
    // reconciling its ladder.
    default: return filled >= amount && amount > 0 ? 'closed' : 'open'
  }
}

function toOrder(row: CrossExOrder): ExchangeOrder {
  const amount = Number(row.qty) || 0
  const filled = Number(row.executed_qty) || 0
  const average = Number(row.executed_avg_price)
  const tif = (row.time_in_force ?? 'GTC').toUpperCase()
  return {
    id: row.order_id,
    symbol: row.symbol,
    type: row.type?.toUpperCase() === 'MARKET' ? 'market' : 'limit',
    side: row.side?.toUpperCase() === 'SELL' ? 'sell' : 'buy',
    price: Number(row.price) || 0,
    ...(Number.isFinite(average) && average > 0 ? { average } : {}),
    amount,
    filled,
    remaining: Math.max(0, amount - filled),
    status: orderStatus(row.state ?? '', filled, amount),
    timestamp: Number(row.create_time) || Date.now(),
    reduceOnly: String(row.reduce_only) === 'true',
    timeInForce: tif === 'POC' ? 'PO' : (['GTC', 'IOC', 'FOK'].includes(tif) ? tif as 'GTC' | 'IOC' | 'FOK' : 'GTC'),
    ...(row.fee !== undefined ? { fee: { cost: Number(row.fee) || 0, currency: row.fee_coin ?? '' } } : {}),
    info: row,
  }
}
