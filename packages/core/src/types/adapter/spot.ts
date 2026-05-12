import type {
  Ticker, Kline, OrderBook,
  ExchangeBalance, ExchangeOrder, ExchangeTrade,
  SpotOrderParams,
} from './exchange.js'

/**
 * 现货交易所 Adapter
 *
 * 覆盖现货市场的行情查询、账户查询、交易操作和 WebSocket 实时数据。
 * 永续合约交易所请使用 PerpExchangeAdapter。
 *
 * 实现约定：
 * - watch* 方法应持续运行（内部 while(true) 循环），直到 close() 被调用
 * - 所有方法在网络错误时应抛出异常，由调用方决定重试策略
 * - symbol 格式遵循 ccxt 规范：现货 'BTC/USDT'，永续 'BTC/USDT:USDT'
 */
export interface SpotExchangeAdapter {
  // ── 行情 ──────────────────────────────────────────────────────────────────

  /** 获取单个交易对的行情快照 */
  fetchTicker(symbol: string): Promise<Ticker>

  /** 获取订单簿，depth 为档位数量（默认由实现决定） */
  fetchOrderBook(symbol: string, depth?: number): Promise<OrderBook>

  /**
   * 获取 K 线数据
   * @param timeframe ccxt 格式，如 '1m' '5m' '1h' '1d'
   * @param limit 返回条数，从最新往前
   */
  fetchOHLCV(symbol: string, timeframe: string, limit?: number): Promise<Kline[]>

  /** 获取最近公开成交记录 */
  fetchTrades(symbol: string, limit?: number): Promise<ExchangeTrade[]>

  // ── 账户 ──────────────────────────────────────────────────────────────────

  /** 获取所有币种余额，仅返回 total > 0 的条目 */
  fetchBalance(): Promise<ExchangeBalance[]>

  /** 获取当前挂单，symbol 为空时返回所有交易对的挂单 */
  fetchOpenOrders(symbol?: string): Promise<ExchangeOrder[]>

  /** 获取历史订单（含已成交/已取消），symbol 为空时返回所有 */
  fetchOrders(symbol?: string, limit?: number): Promise<ExchangeOrder[]>

  // ── 交易 ──────────────────────────────────────────────────────────────────

  /** 下单，返回订单详情 */
  createOrder(params: SpotOrderParams): Promise<ExchangeOrder>

  /** 撤销指定订单 */
  cancelOrder(orderId: string, symbol: string): Promise<void>

  /**
   * 撤销所有挂单
   * 注意：部分交易所不原生支持此接口，实现层可能降级为逐个撤单
   */
  cancelAllOrders(symbol?: string): Promise<void>

  // ── WebSocket ─────────────────────────────────────────────────────────────

  /**
   * 订阅行情推送，每次收到更新时调用 callback
   * 此方法持续运行，调用 close() 后退出
   */
  watchTicker(symbol: string, callback: (ticker: Ticker) => void): Promise<void>

  /**
   * 订阅公开成交流，每次推送一批新成交
   * 此方法持续运行，调用 close() 后退出
   */
  watchTrades(symbol: string, callback: (trades: ExchangeTrade[]) => void): Promise<void>

  /**
   * 订阅订单簿推送
   * 此方法持续运行，调用 close() 后退出
   */
  watchOrderBook(symbol: string, callback: (orderBook: OrderBook) => void, depth?: number): Promise<void>

  /**
   * 订阅账户成交流（私有频道）
   * params 可传入 { user: '0x...' } 以监听指定地址（Hyperliquid 等支持此特性的交易所）
   * 此方法持续运行，调用 close() 后退出
   */
  watchMyTrades(callback: (trades: ExchangeTrade[]) => void, params?: Record<string, unknown>): Promise<void>

  /**
   * 订阅订单状态变更推送（私有频道）
   * symbol 为 undefined 时订阅所有交易对
   * 此方法持续运行，调用 close() 后退出
   */
  watchOrders(symbol: string | undefined, callback: (orders: ExchangeOrder[]) => void): Promise<void>

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /** 关闭所有 WebSocket 连接，释放资源 */
  close(): Promise<void>
}
