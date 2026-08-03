// Data types
export type {
  Ticker, Kline, OrderBook, MarketInfo,
  ExchangeBalance, ExchangePosition, ExchangeOrder, ExchangeTrade, ExchangeFill, FundingEvent,
  FundingRateData, OpenInterestData, SpotOrderParams, PerpOrderParams,
} from './types/exchange.js'
export type { SpotExchangeAdapter } from './types/spot.js'
export type { PerpExchangeAdapter, LeverageTier } from './types/perp.js'
export type { IAccountBalance, ITokenBalance, IPosition, IOrder, IPnL, IHistoryRecord } from './types/account.js'

// Reader + executor
export { PerpAccount } from './account/PerpAccount.js'
export type { PerpAccountOptions } from './account/PerpAccount.js'
export { SpotAccount } from './account/SpotAccount.js'
export type { SpotAccountOptions } from './account/SpotAccount.js'
export { PerpTradingExecutor } from './executor/PerpTradingExecutor.js'
export type { PerpInstruction } from './executor/PerpTradingExecutor.js'
export { SpotTradingExecutor } from './executor/SpotTradingExecutor.js'
export type { SpotInstruction } from './executor/SpotTradingExecutor.js'

// Monitors (venue-agnostic, over public sessions)
export { PublicMarketMonitor, parseMarketKey, sleep } from './monitor/PublicMarketMonitor.js'
export type { ParsedMarketKey, MarketKeyShape } from './monitor/PublicMarketMonitor.js'
export { TickerMonitor } from './monitor/TickerMonitor.js'
export type { TickerMonitorOptions, TickerUpdate } from './monitor/TickerMonitor.js'
export { KlineMonitor, KLINE_TIMEFRAMES } from './monitor/KlineMonitor.js'
export type { KlineMonitorOptions, KlineUpdate, KlineTimeframe } from './monitor/KlineMonitor.js'
export { OrderBookMonitor } from './monitor/OrderBookMonitor.js'
export type { OrderBookMonitorOptions, OrderBookUpdate } from './monitor/OrderBookMonitor.js'
export { TradeTapeMonitor } from './monitor/TradeTapeMonitor.js'
export type { TradeTapeMonitorOptions, TradeTapeUpdate } from './monitor/TradeTapeMonitor.js'
export { FundingRateMonitor, alignedIntervalHours } from './monitor/FundingRateMonitor.js'
export type { FundingRateMonitorOptions, FundingSnapshot, FundingRateEntry } from './monitor/FundingRateMonitor.js'
export { OpenInterestMonitor } from './monitor/OpenInterestMonitor.js'
export type { OpenInterestMonitorOptions, OpenInterestUpdate } from './monitor/OpenInterestMonitor.js'
export { VolumeMonitor } from './monitor/VolumeMonitor.js'
export type { VolumeMonitorOptions, VolumeUpdate } from './monitor/VolumeMonitor.js'

// Plugin
export { exchangeTradeSchema } from './schemas.js'
export { MockPerpAdapter } from './mock/MockPerpAdapter.js'
export { exchangePlugin } from './plugin.js'

// Kind contracts — merged into core's kind table
import type { PerpExchangeAdapter } from './types/perp.js'
import type { SpotExchangeAdapter } from './types/spot.js'
import type { PerpAccount as PerpAccountClass } from './account/PerpAccount.js'
import type { SpotAccount as SpotAccountClass } from './account/SpotAccount.js'
declare module '@openwhaleorg/core' {
  interface AdapterKindMap {
    'exchange/perp': { session: PerpExchangeAdapter; reader: PerpAccountClass }
    'exchange/spot': { session: SpotExchangeAdapter; reader: SpotAccountClass }
  }
}

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
