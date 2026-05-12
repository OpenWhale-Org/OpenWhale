/**
 * @openwhale/core adapter types
 *
 * 目录结构：
 *   base.ts     — IAdapter 通用接口（框架层）
 *   exchange.ts — 交易所共享数据类型（Ticker / Order / Position 等）
 *   spot.ts     — SpotExchangeAdapter（现货）
 *   perp.ts     — PerpExchangeAdapter（永续合约，继承 Spot）
 */
export type { AdapterQueryOptions, AdapterExecuteOptions, IAdapter } from './base.js'
export type {
  Ticker, Kline, OrderBook,
  ExchangeBalance, ExchangePosition, ExchangeOrder, ExchangeTrade,
  FundingRateData, SpotOrderParams, PerpOrderParams,
} from './exchange.js'
export type { SpotExchangeAdapter } from './spot.js'
export type { PerpExchangeAdapter } from './perp.js'
