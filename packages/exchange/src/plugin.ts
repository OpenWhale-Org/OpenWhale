import { definePlugin } from '@openwhaleorg/core'
import { PerpTradingExecutor } from './executor/PerpTradingExecutor.js'
import { SpotTradingExecutor } from './executor/SpotTradingExecutor.js'
import { PerpAccount } from './account/PerpAccount.js'
import { SpotAccount } from './account/SpotAccount.js'
import { MockPerpAdapter } from './mock/MockPerpAdapter.js'
import { FundingRateMonitor } from './monitor/FundingRateMonitor.js'
import { TickerMonitor } from './monitor/TickerMonitor.js'
import { KlineMonitor } from './monitor/KlineMonitor.js'
import { OrderBookMonitor } from './monitor/OrderBookMonitor.js'
import { TradeTapeMonitor } from './monitor/TradeTapeMonitor.js'
import { OpenInterestMonitor } from './monitor/OpenInterestMonitor.js'
import { VolumeMonitor } from './monitor/VolumeMonitor.js'

/**
 * The exchange domain plugin — a pure manifest. Every component carries its
 * own metadata (@OwMonitor/@OwAccount/@OwExecutor); monitor tuning lives on
 * MONITOR INSTANCES (dashboard-filled, frozen while active), so there is no
 * plugin config at all.
 *
 * The kinds 'exchange/perp' / 'exchange/spot' are defined by USE — the mock
 * adapter cells below plus the account implementations claim them (plus the
 * AdapterKindMap declaration merging in index.ts for the type level). Venue
 * packages (binance, hyperliquid, aster, …) fill in the real venue cells.
 */
export const exchangePlugin = definePlugin({
  name: 'exchange',
  version: '1.0.0',

  // 'mock' is an ordinary venue column: canned data + no-op writes, powering
  // the AI compiler's dry-runs (fresh instance per run, resolved by cell).
  adapters: [
    { kind: 'exchange/perp', type: 'mock', create: () => new MockPerpAdapter() },
    // The perp mock is a structural superset of the spot surface — reuse it
    { kind: 'exchange/spot', type: 'mock', create: () => new MockPerpAdapter() },
  ],

  accounts: [PerpAccount, SpotAccount],

  monitors: [
    FundingRateMonitor,
    TickerMonitor,
    KlineMonitor,
    OrderBookMonitor,
    TradeTapeMonitor,
    OpenInterestMonitor,
    VolumeMonitor,
  ],

  executors: [PerpTradingExecutor, SpotTradingExecutor],
})

export default exchangePlugin
