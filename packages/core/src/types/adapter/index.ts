/**
 * @openwhale/core adapter types
 *
 * Directory structure:
 *   base.ts     — IAdapter generic interface (framework layer)
 *   exchange.ts — Shared exchange data types (Ticker / Order / Position, etc.)
 *   spot.ts     — SpotExchangeAdapter (spot trading)
 *   perp.ts     — PerpExchangeAdapter (perpetual futures, extends Spot)
 */
export type { AdapterQueryOptions, AdapterExecuteOptions, IAdapter } from './base.js'
export type {
  Ticker, Kline, OrderBook,
  ExchangeBalance, ExchangePosition, ExchangeOrder, ExchangeTrade,
  FundingRateData, SpotOrderParams, PerpOrderParams,
} from './exchange.js'
export type { SpotExchangeAdapter } from './spot.js'
export type { PerpExchangeAdapter } from './perp.js'
