export interface AdapterQueryOptions {
  limit?: number
  offset?: number
  [key: string]: unknown
}

export interface AdapterExecuteOptions {
  dryRun?: boolean
  [key: string]: unknown
}

export interface IAdapter {
  readonly adapterName: string
  query(method: string, params: Record<string, unknown>, options?: AdapterQueryOptions): Promise<unknown>
  execute(action: string, params: Record<string, unknown>, options?: AdapterExecuteOptions): Promise<unknown>
}

// ── Exchange Adapter types ────────────────────────────────────────────────────

export interface Ticker {
  symbol: string
  timestamp: number
  last: number
  bid: number
  ask: number
  high: number
  low: number
  volume: number        // base asset volume
  quoteVolume: number   // quote asset volume
}

export interface Kline {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface OrderBook {
  symbol: string
  timestamp: number
  bids: [number, number][]  // [price, amount][]
  asks: [number, number][]
}

export interface ExchangeBalance {
  currency: string
  free: number    // available
  used: number    // in orders / margin
  total: number
}

export interface ExchangePosition {
  symbol: string
  side: 'long' | 'short'
  contracts: number       // position size in contracts
  contractSize: number    // value per contract
  entryPrice: number
  markPrice: number
  notional: number        // contracts * contractSize * markPrice
  unrealizedPnl: number
  leverage: number
  liquidationPrice: number
  marginMode: 'cross' | 'isolated'
  initialMargin: number
  maintenanceMargin: number
}

export interface ExchangeOrder {
  id: string
  symbol: string
  type: 'market' | 'limit'
  side: 'buy' | 'sell'
  price: number
  amount: number
  filled: number
  remaining: number
  status: 'open' | 'closed' | 'canceled' | 'rejected' | 'expired'
  timestamp: number
  reduceOnly: boolean
  timeInForce: 'GTC' | 'IOC' | 'FOK' | 'PO'
  fee?: { cost: number; currency: string }
}

export interface ExchangeTrade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  price: number
  amount: number
  cost: number            // price * amount
  timestamp: number
  fee?: { cost: number; currency: string }
  takerOrMaker: 'taker' | 'maker'
}

export interface FundingRateData {
  symbol: string
  fundingRate: number
  fundingTimestamp: number
  nextFundingTimestamp: number
}

export interface SpotOrderParams {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  amount: number
  price?: number
  clientOrderId?: string
  params?: Record<string, unknown>  // exchange-specific passthrough
}

export interface PerpOrderParams extends SpotOrderParams {
  reduceOnly?: boolean
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PO'
}

// ── SpotExchangeAdapter ───────────────────────────────────────────────────────

export interface SpotExchangeAdapter {
  // Market data
  fetchTicker(symbol: string): Promise<Ticker>
  fetchOrderBook(symbol: string, depth?: number): Promise<OrderBook>
  fetchOHLCV(symbol: string, timeframe: string, limit?: number): Promise<Kline[]>
  fetchTrades(symbol: string, limit?: number): Promise<ExchangeTrade[]>

  // Account
  fetchBalance(): Promise<ExchangeBalance[]>
  fetchOpenOrders(symbol?: string): Promise<ExchangeOrder[]>
  fetchOrders(symbol?: string, limit?: number): Promise<ExchangeOrder[]>

  // Trading
  createOrder(params: SpotOrderParams): Promise<ExchangeOrder>
  cancelOrder(orderId: string, symbol: string): Promise<void>
  cancelAllOrders(symbol?: string): Promise<void>

  // WebSocket
  watchTicker(symbol: string, callback: (ticker: Ticker) => void): Promise<void>
  watchTrades(symbol: string, callback: (trades: ExchangeTrade[]) => void): Promise<void>
  watchOrderBook(symbol: string, callback: (orderBook: OrderBook) => void, depth?: number): Promise<void>
  watchMyTrades(callback: (trades: ExchangeTrade[]) => void, params?: Record<string, unknown>): Promise<void>
  watchOrders(symbol: string | undefined, callback: (orders: ExchangeOrder[]) => void): Promise<void>

  close(): Promise<void>
}

// ── PerpExchangeAdapter ───────────────────────────────────────────────────────

export interface PerpExchangeAdapter extends SpotExchangeAdapter {
  // Perp-specific market data
  fetchFundingRate(symbol: string): Promise<FundingRateData>
  fetchFundingRates(): Promise<FundingRateData[]>

  // Perp account
  fetchPositions(symbols?: string[]): Promise<ExchangePosition[]>
  fetchPosition(symbol: string): Promise<ExchangePosition>

  // Perp trading
  createOrder(params: PerpOrderParams): Promise<ExchangeOrder>
  setLeverage(symbol: string, leverage: number, params?: Record<string, unknown>): Promise<void>
  setMarginMode(symbol: string, marginMode: 'cross' | 'isolated'): Promise<void>
}
