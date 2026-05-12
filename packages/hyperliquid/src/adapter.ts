import * as ccxt from 'ccxt'
import type {
  PerpExchangeAdapter,
  Ticker, Kline, OrderBook,
  ExchangeBalance, ExchangePosition, ExchangeOrder, ExchangeTrade,
  FundingRateData, SpotOrderParams, PerpOrderParams,
} from '@openwhale/core'

export interface HyperliquidCredentials {
  walletAddress: string
  privateKey?: string
}

export class HyperliquidAdapter implements PerpExchangeAdapter {
  private readonly exchange: InstanceType<typeof ccxt.pro.hyperliquid>

  constructor(credentials: HyperliquidCredentials) {
    const opts: ConstructorParameters<typeof ccxt.pro.hyperliquid>[0] = {
      walletAddress: credentials.walletAddress,
      enableRateLimit: true,
    }
    if (credentials.privateKey) opts.privateKey = credentials.privateKey
    this.exchange = new ccxt.pro.hyperliquid(opts)
  }

  // ── Market data ─────────────────────────────────────────────────────────────

  async fetchTicker(symbol: string): Promise<Ticker> {
    const t = await this.exchange.fetchTicker(symbol)
    return {
      symbol: t.symbol,
      timestamp: t.timestamp ?? Date.now(),
      last: t.last ?? 0,
      bid: t.bid ?? 0,
      ask: t.ask ?? 0,
      high: t.high ?? 0,
      low: t.low ?? 0,
      volume: t.baseVolume ?? 0,
      quoteVolume: t.quoteVolume ?? 0,
    }
  }

  async fetchOrderBook(symbol: string, depth = 20): Promise<OrderBook> {
    const ob = await this.exchange.fetchOrderBook(symbol, depth)
    return {
      symbol,
      timestamp: ob.timestamp ?? Date.now(),
      bids: ob.bids as [number, number][],
      asks: ob.asks as [number, number][],
    }
  }

  async fetchOHLCV(symbol: string, timeframe: string, limit = 100): Promise<Kline[]> {
    const rows = await this.exchange.fetchOHLCV(symbol, timeframe, undefined, limit)
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
    const trades = await this.exchange.fetchTrades(symbol, undefined, limit)
    return trades.map(this.mapTrade)
  }

  // ── Account ─────────────────────────────────────────────────────────────────

  async fetchBalance(): Promise<ExchangeBalance[]> {
    const bal = await this.exchange.fetchBalance()
    const free = bal.free as Record<string, number> | undefined
    const used = bal.used as Record<string, number> | undefined
    const total = bal.total as Record<string, number> | undefined
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
    const orders = await this.exchange.fetchOpenOrders(symbol)
    return orders.map(this.mapOrder)
  }

  async fetchOrders(symbol?: string, limit = 50): Promise<ExchangeOrder[]> {
    const orders = await this.exchange.fetchOrders(symbol, undefined, limit)
    return orders.map(this.mapOrder)
  }

  // ── Trading ─────────────────────────────────────────────────────────────────

  async createOrder(params: PerpOrderParams): Promise<ExchangeOrder> {
    const extra: Record<string, unknown> = { ...(params.params ?? {}) }
    if (params.reduceOnly !== undefined) extra.reduceOnly = params.reduceOnly
    if (params.timeInForce !== undefined) extra.timeInForce = params.timeInForce

    const order = await this.exchange.createOrder(
      params.symbol,
      params.type,
      params.side,
      params.amount,
      params.price,
      extra,
    )
    return this.mapOrder(order)
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    await this.exchange.cancelOrder(orderId, symbol)
  }

  async cancelAllOrders(symbol?: string): Promise<void> {
    // ccxt HL does not support cancelAllOrders — cancel open orders one by one
    const orders = await this.fetchOpenOrders(symbol)
    await Promise.all(orders.map(o => this.cancelOrder(o.id, o.symbol)))
  }

  // ── Perp-specific ────────────────────────────────────────────────────────────

  async fetchFundingRate(symbol: string): Promise<FundingRateData> {
    // HL does not support fetchFundingRate per symbol — use fetchFundingRates
    const rates = await this.fetchFundingRates()
    const rate = rates.find(r => r.symbol === symbol)
    if (!rate) throw new Error(`Funding rate not found for ${symbol}`)
    return rate
  }

  async fetchFundingRates(): Promise<FundingRateData[]> {
    const rates = await this.exchange.fetchFundingRates()
    return Object.values(rates).map((r: any) => ({
      symbol: r.symbol,
      fundingRate: r.fundingRate ?? 0,
      fundingTimestamp: r.fundingTimestamp ?? 0,
      nextFundingTimestamp: r.nextFundingTimestamp ?? 0,
    }))
  }

  async fetchPositions(symbols?: string[]): Promise<ExchangePosition[]> {
    const positions = await this.exchange.fetchPositions(symbols)
    return positions.map(this.mapPosition)
  }

  async fetchPosition(symbol: string): Promise<ExchangePosition> {
    const pos = await this.exchange.fetchPosition(symbol)
    return this.mapPosition(pos)
  }

  async setLeverage(symbol: string, leverage: number, params?: Record<string, unknown>): Promise<void> {
    await this.exchange.setLeverage(leverage, symbol, params)
  }

  async setMarginMode(symbol: string, marginMode: 'cross' | 'isolated'): Promise<void> {
    await this.exchange.setMarginMode(marginMode, symbol)
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────

  async watchTicker(symbol: string, callback: (ticker: Ticker) => void): Promise<void> {
    while (true) {
      const t = await this.exchange.watchTicker(symbol)
      callback({
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
    }
  }

  async watchTrades(symbol: string, callback: (trades: ExchangeTrade[]) => void): Promise<void> {
    while (true) {
      const trades = await this.exchange.watchTrades(symbol)
      callback(trades.map(this.mapTrade))
    }
  }

  async watchOrderBook(symbol: string, callback: (ob: OrderBook) => void, depth = 20): Promise<void> {
    while (true) {
      const ob = await this.exchange.watchOrderBook(symbol, depth)
      callback({
        symbol,
        timestamp: ob.timestamp ?? Date.now(),
        bids: ob.bids as [number, number][],
        asks: ob.asks as [number, number][],
      })
    }
  }

  async watchMyTrades(callback: (trades: ExchangeTrade[]) => void, params?: Record<string, unknown>): Promise<void> {
    while (true) {
      const trades = await this.exchange.watchMyTrades(undefined, undefined, undefined, params)
      callback(trades.map(this.mapTrade))
    }
  }

  async watchOrders(symbol: string | undefined, callback: (orders: ExchangeOrder[]) => void): Promise<void> {
    while (true) {
      const orders = await this.exchange.watchOrders(symbol)
      callback(orders.map(this.mapOrder))
    }
  }

  async close(): Promise<void> {
    await this.exchange.close()
  }

  // ── Mappers ──────────────────────────────────────────────────────────────────

  private mapTrade(t: any): ExchangeTrade {
    const trade: ExchangeTrade = {
      id: t.id ?? '',
      symbol: t.symbol ?? '',
      side: t.side,
      price: t.price ?? 0,
      amount: t.amount ?? 0,
      cost: t.cost ?? 0,
      timestamp: t.timestamp ?? Date.now(),
      takerOrMaker: t.takerOrMaker ?? 'taker',
    }
    if (t.fee) trade.fee = { cost: t.fee.cost ?? 0, currency: t.fee.currency ?? '' }
    return trade
  }

  private mapOrder(o: any): ExchangeOrder {
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
    }
    if (o.fee) order.fee = { cost: o.fee.cost ?? 0, currency: o.fee.currency ?? '' }
    return order
  }

  private mapPosition(p: any): ExchangePosition {
    return {
      symbol: p.symbol ?? '',
      side: p.side ?? 'long',
      contracts: p.contracts ?? 0,
      contractSize: p.contractSize ?? 1,
      entryPrice: p.entryPrice ?? 0,
      markPrice: p.markPrice ?? 0,
      notional: p.notional ?? 0,
      unrealizedPnl: p.unrealizedPnl ?? 0,
      leverage: p.leverage ?? 1,
      liquidationPrice: p.liquidationPrice ?? 0,
      marginMode: p.marginMode ?? 'cross',
      initialMargin: p.initialMargin ?? 0,
      maintenanceMargin: p.maintenanceMargin ?? 0,
    }
  }
}
