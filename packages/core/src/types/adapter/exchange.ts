/**
 * 交易所 Adapter 共享数据类型
 *
 * 字段命名与 ccxt 对齐，降低实现层的映射成本。
 * 所有价格/数量均为 number（浮点），货币单位由 symbol 或 currency 字段标识。
 */

/** 行情快照 */
export interface Ticker {
  symbol: string
  timestamp: number
  last: number          // 最新成交价
  bid: number           // 买一价
  ask: number           // 卖一价
  high: number          // 24h 最高价
  low: number           // 24h 最低价
  volume: number        // 24h 成交量（基础资产）
  quoteVolume: number   // 24h 成交额（计价资产）
}

/** K 线（OHLCV） */
export interface Kline {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * 订单簿快照
 * bids/asks 按价格排序：bids 降序（最优买价在前），asks 升序（最优卖价在前）
 */
export interface OrderBook {
  symbol: string
  timestamp: number
  bids: [number, number][]  // [price, amount][]
  asks: [number, number][]
}

/** 账户余额（单币种） */
export interface ExchangeBalance {
  currency: string
  free: number    // 可用余额
  used: number    // 占用中（挂单保证金 / 仓位保证金）
  total: number   // free + used
}

/**
 * 永续合约持仓
 * notional = contracts × contractSize × markPrice（名义价值，USD 计）
 */
export interface ExchangePosition {
  symbol: string
  side: 'long' | 'short'
  contracts: number         // 持仓张数
  contractSize: number      // 每张合约面值
  entryPrice: number        // 开仓均价
  markPrice: number         // 当前标记价格
  notional: number          // 名义价值（USD）
  unrealizedPnl: number     // 未实现盈亏（USD）
  leverage: number          // 当前杠杆倍数
  liquidationPrice: number  // 强平价格
  marginMode: 'cross' | 'isolated'
  initialMargin: number     // 初始保证金
  maintenanceMargin: number // 维持保证金
}

/** 订单 */
export interface ExchangeOrder {
  id: string
  symbol: string
  type: 'market' | 'limit'
  side: 'buy' | 'sell'
  price: number
  amount: number    // 委托数量（基础资产）
  filled: number    // 已成交数量
  remaining: number // 未成交数量
  status: 'open' | 'closed' | 'canceled' | 'rejected' | 'expired'
  timestamp: number
  reduceOnly: boolean
  timeInForce: 'GTC' | 'IOC' | 'FOK' | 'PO'
  fee?: { cost: number; currency: string }
}

/** 成交记录（单笔） */
export interface ExchangeTrade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  price: number
  amount: number
  cost: number      // price × amount（成交额）
  timestamp: number
  fee?: { cost: number; currency: string }
  takerOrMaker: 'taker' | 'maker'
}

/** 资金费率 */
export interface FundingRateData {
  symbol: string
  fundingRate: number           // 当期资金费率（小数，如 0.0001 = 0.01%）
  fundingTimestamp: number      // 当期结算时间戳（ms）
  nextFundingTimestamp: number  // 下期结算时间戳（ms）
}

/** 现货下单参数 */
export interface SpotOrderParams {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  amount: number
  price?: number          // limit 单必填
  clientOrderId?: string  // 客户端自定义订单 ID，用于幂等性校验
  /** 交易所特有参数透传，不影响通用接口语义 */
  params?: Record<string, unknown>
}

/** 永续合约下单参数（扩展现货参数） */
export interface PerpOrderParams extends SpotOrderParams {
  /** 只减仓，不开新仓 */
  reduceOnly?: boolean
  /** 订单有效期类型：GTC=一直有效 / IOC=立即成交否则取消 / FOK=全部成交否则取消 / PO=只做 Maker */
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PO'
}
