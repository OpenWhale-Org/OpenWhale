import type {
  Ticker, Kline, OrderBook,
  ExchangeBalance, ExchangeOrder, ExchangeTrade,
  SpotOrderParams,
} from './exchange.js'

/**
 * Spot exchange adapter.
 *
 * Covers market data queries, account queries, trading operations, and WebSocket streaming for spot markets.
 * For perpetual futures, use PerpExchangeAdapter instead.
 *
 * Implementation conventions:
 * - watch* methods should run continuously (internal while(true) loop) until close() is called
 * - All methods should throw on network errors; retry strategy is the caller's responsibility
 * - symbol format follows ccxt convention: spot 'BTC/USDT', perp 'BTC/USDT:USDT'
 */
export interface SpotExchangeAdapter {
  // ── Market data ───────────────────────────────────────────────────────────

  /** Fetch ticker snapshot for a single symbol */
  fetchTicker(symbol: string): Promise<Ticker>

  /** Fetch order book; depth is the number of levels (default determined by implementation) */
  fetchOrderBook(symbol: string, depth?: number): Promise<OrderBook>

  /**
   * Fetch OHLCV candlestick data.
   * @param timeframe ccxt format, e.g. '1m' '5m' '1h' '1d'
   * @param limit number of candles to return, from most recent
   */
  fetchOHLCV(symbol: string, timeframe: string, limit?: number): Promise<Kline[]>

  /** Fetch recent public trades */
  fetchTrades(symbol: string, limit?: number): Promise<ExchangeTrade[]>

  // ── Account ───────────────────────────────────────────────────────────────

  /** Fetch all balances; returns only entries where total > 0 */
  fetchBalance(): Promise<ExchangeBalance[]>

  /** Fetch open orders; returns all symbols if symbol is omitted */
  fetchOpenOrders(symbol?: string): Promise<ExchangeOrder[]>

  /** Fetch order history (including filled/canceled); returns all symbols if symbol is omitted */
  fetchOrders(symbol?: string, limit?: number): Promise<ExchangeOrder[]>

  // ── Trading ───────────────────────────────────────────────────────────────

  /** Place an order; returns order details */
  createOrder(params: SpotOrderParams): Promise<ExchangeOrder>

  /** Cancel a specific order */
  cancelOrder(orderId: string, symbol: string): Promise<void>

  /**
   * Cancel all open orders.
   * Note: some exchanges don't natively support this; implementations may fall back to canceling one by one.
   */
  cancelAllOrders(symbol?: string): Promise<void>

  // ── WebSocket ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to ticker updates; callback is invoked on each update.
   * Runs continuously until close() is called.
   */
  watchTicker(symbol: string, callback: (ticker: Ticker) => void): Promise<void>

  /**
   * Subscribe to public trade stream; callback receives a batch of new trades.
   * Runs continuously until close() is called.
   */
  watchTrades(symbol: string, callback: (trades: ExchangeTrade[]) => void): Promise<void>

  /**
   * Subscribe to order book updates.
   * Runs continuously until close() is called.
   */
  watchOrderBook(symbol: string, callback: (orderBook: OrderBook) => void, depth?: number): Promise<void>

  /**
   * Subscribe to private trade stream (own fills).
   * Pass { user: '0x...' } in params to monitor a specific address (supported by Hyperliquid and similar exchanges).
   * Runs continuously until close() is called.
   */
  watchMyTrades(callback: (trades: ExchangeTrade[]) => void, params?: Record<string, unknown>): Promise<void>

  /**
   * Subscribe to order status updates (private channel).
   * Subscribes to all symbols if symbol is undefined.
   * Runs continuously until close() is called.
   */
  watchOrders(symbol: string | undefined, callback: (orders: ExchangeOrder[]) => void): Promise<void>

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Close all WebSocket connections and release resources */
  close(): Promise<void>
}
