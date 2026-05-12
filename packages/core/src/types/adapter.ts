// Re-export from adapter subdirectory — see types/adapter/ for source files
export type { AdapterQueryOptions, AdapterExecuteOptions, IAdapter } from './adapter/base.js'
export type {
  Ticker, Kline, OrderBook,
  ExchangeBalance, ExchangePosition, ExchangeOrder, ExchangeTrade,
  FundingRateData, SpotOrderParams, PerpOrderParams,
} from './adapter/exchange.js'
export type { SpotExchangeAdapter } from './adapter/spot.js'
export type { PerpExchangeAdapter } from './adapter/perp.js'
