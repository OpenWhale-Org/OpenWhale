import type {
  Ticker, Kline, OrderBook, MarketInfo,
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
 * - watch* methods run continuously (internal while(true) loop) until the passed
 *   AbortSignal is aborted or close() is called; on abort they resolve promptly
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
  /**
   * Closed + forming candles, newest last. `since` (epoch ms) asks for
   * candles FROM that time forward — the pagination cursor for histories
   * deeper than the venue's per-request cap (ccxt clamps Binance at 1000).
   */
  fetchOHLCV(symbol: string, timeframe: string, limit?: number, since?: number): Promise<Kline[]>

  /** Fetch recent public trades */
  fetchTrades(symbol: string, limit?: number): Promise<ExchangeTrade[]>

  /**
   * Every market the venue lists — the vocabulary of valid symbols.
   *
   * Optional: venues without a market catalogue simply omit it and callers
   * fall back to free-form symbol entry. Needs no credential, so a picker can
   * populate itself from the public session before any key is stored.
   */
  fetchMarkets?(): Promise<MarketInfo[]>

  // ── Account ───────────────────────────────────────────────────────────────

  /** Fetch all balances; returns only entries where total > 0 */
  fetchBalance(): Promise<ExchangeBalance[]>

  /** Fetch open orders; returns all symbols if symbol is omitted */
  fetchOpenOrders(symbol?: string): Promise<ExchangeOrder[]>

  /** Fetch order history (including filled/canceled); returns all symbols if symbol is omitted */
  fetchOrders(symbol?: string, limit?: number): Promise<ExchangeOrder[]>

  /**
   * Fetch a single order by id — the reconciliation primitive: after createOrder,
   * this is how callers follow up on fill status.
   */
  fetchOrder(orderId: string, symbol: string): Promise<ExchangeOrder>

  /**
   * Look up an order by CLIENT order id — the disambiguation primitive for
   * idempotent retries: "did my createOrder with this clientOrderId reach the
   * venue?". Resolves undefined when the venue has no such order (definitely
   * not placed). Optional: not every venue supports client-id lookup.
   */
  fetchOrderByClientId?(clientOrderId: string, symbol: string): Promise<ExchangeOrder | undefined>

  /** Fetch own fills (REST). The backfill/reconciliation counterpart of watchMyTrades. */
  fetchMyTrades(symbol?: string, limit?: number): Promise<ExchangeTrade[]>

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

  /**
   * Round an order amount down to the market's lot precision.
   * Callers must apply this before createOrder — venues reject off-lot amounts.
   */
  amountToPrecision(symbol: string, amount: number): Promise<number>

  /**
   * Round a price to the market's tick size. Required before submitting a
   * LIMIT order — venues reject a price off the tick grid outright.
   *
   * Optional so existing adapters keep compiling; callers that need it must
   * degrade (skip the limit, or send the raw price) when it is absent.
   */
  priceToPrecision?(symbol: string, price: number): Promise<number>

  // ── WebSocket ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to ticker updates; callback is invoked on each update.
   * Runs until `signal` is aborted or close() is called.
   */
  watchTicker(symbol: string, callback: (ticker: Ticker) => void, signal?: AbortSignal): Promise<void>

  /**
   * Subscribe to public trade stream; callback receives a batch of new trades.
   * Runs until `signal` is aborted or close() is called.
   */
  watchTrades(symbol: string, callback: (trades: ExchangeTrade[]) => void, signal?: AbortSignal): Promise<void>

  /**
   * Subscribe to order book updates.
   * Runs until `signal` is aborted or close() is called.
   */
  watchOrderBook(symbol: string, callback: (orderBook: OrderBook) => void, depth?: number, signal?: AbortSignal): Promise<void>

  /**
   * Subscribe to private trade stream (own fills).
   * Pass { user: '0x...' } in params to monitor a specific address (supported by Hyperliquid and similar exchanges).
   * Runs until `signal` is aborted or close() is called.
   */
  watchMyTrades(callback: (trades: ExchangeTrade[]) => void, params?: Record<string, unknown>, signal?: AbortSignal): Promise<void>

  /**
   * Subscribe to order status updates (private channel).
   * Subscribes to all symbols if symbol is undefined.
   * Runs until `signal` is aborted or close() is called.
   */
  watchOrders(symbol: string | undefined, callback: (orders: ExchangeOrder[]) => void, signal?: AbortSignal): Promise<void>

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Close all WebSocket connections and release resources */
  close(): Promise<void>
}
