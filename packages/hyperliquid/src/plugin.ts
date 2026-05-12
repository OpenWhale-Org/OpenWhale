import type { OpenWhalePlugin, PluginFactory } from '@openwhale/core'
import { HyperliquidAdapter } from './adapter.js'
import { HyperliquidAccount } from './account.js'
import { UserTradesMonitor } from './monitor.js'
import { PerpTradingExecutor } from './executor.js'
import { CopyTradingStrategy } from './strategy.js'

export interface HyperliquidPluginConfig {
  /** Read-only wallet address used by the monitor and executor (no private key needed). */
  walletAddress: string
}

/**
 * Hyperliquid plugin factory.
 *
 * Registers:
 *   - Monitor:   hl-user-trades  (UserTradesMonitor)
 *   - Executor:  hl-perp-trading (PerpTradingExecutor)
 *   - Strategy:  hl-copy-trading (CopyTradingStrategy)
 *   - Account:   hyperliquid     (HyperliquidAccount factory)
 *
 * Usage:
 *   pluginManager.load(hyperliquidPlugin, { walletAddress: '0x...' })
 */
export const hyperliquidPlugin: PluginFactory<HyperliquidPluginConfig> = (context): OpenWhalePlugin => {
  const now = new Date().toISOString()
  const readAdapter = new HyperliquidAdapter({ walletAddress: context.config.walletAddress })

  return {
    name: 'hyperliquid',
    version: '1.0.0',

    monitors: [
      {
        definition: {
          id: 'hl-user-trades',
          name: 'Hyperliquid User Trades',
          description: 'Streams real-time fills for any Hyperliquid address',
          source: 'plugin',
          pluginName: 'hyperliquid',
          createdAt: now,
          updatedAt: now,
        },
        instance: new UserTradesMonitor(readAdapter),
      },
    ],

    executors: [
      {
        definition: {
          id: 'hl-perp-trading',
          name: 'Hyperliquid Perp Trading',
          description: 'Places, cancels, and manages perpetual orders on Hyperliquid',
          source: 'plugin',
          pluginName: 'hyperliquid',
          supportedActions: ['placeOrder', 'cancelOrder', 'setLeverage'],
          createdAt: now,
          updatedAt: now,
        },
        instance: new PerpTradingExecutor(readAdapter),
      },
    ],

    strategies: [
      {
        definition: {
          id: 'hl-copy-trading',
          name: 'Hyperliquid Copy Trading',
          description: "Mirrors another trader's perpetual positions at a configurable ratio",
          source: 'plugin',
          pluginName: 'hyperliquid',
          monitorIds: ['hl-user-trades'],
          executorIds: ['hl-perp-trading'],
          createdAt: now,
          updatedAt: now,
        },
        factory: () => new CopyTradingStrategy(),
      },
    ],

    accounts: [
      {
        accountType: 'hyperliquid',
        factory: (data) =>
          new HyperliquidAccount(
            'hyperliquid',
            new HyperliquidAdapter({
              walletAddress: data['walletAddress'] as string,
              privateKey: data['privateKey'] as string,
            }),
          ),
      },
    ],
  }
}

export default hyperliquidPlugin
