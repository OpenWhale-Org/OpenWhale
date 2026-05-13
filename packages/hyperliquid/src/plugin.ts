import type { OpenWhalePlugin, PluginFactory } from '@openwhale/core'
import { HyperliquidAdapter } from './adapter.js'
import { HyperliquidAccount } from './account.js'
import { UserTradesMonitor } from './monitor.js'
import { PerpTradingExecutor } from './executor.js'
import { CopyTradingStrategy } from './strategy.js'

export interface HyperliquidPluginConfig {
  /** Wallet address used by the monitor. */
  walletAddress: string
  /** Private key for signing orders. If omitted, the executor will be read-only and order placement will fail. */
  privateKey?: string
}

/**
 * Hyperliquid plugin factory.
 *
 * Component logical names (auto-prefixed to 'hyperliquid/...' by loadPlugin):
 *   - Monitor:   user-trades  → hyperliquid/user-trades
 *   - Executor:  perp-trading → hyperliquid/perp-trading
 *   - Strategy:  copy-trading → hyperliquid/copy-trading
 *   - Account:   hyperliquid
 *
 * Usage:
 *   runtime.loadPlugin(hyperliquidPlugin, { walletAddress: '0x...' })
 */
export const hyperliquidPlugin: PluginFactory<HyperliquidPluginConfig> = (context): OpenWhalePlugin => {
  const now = new Date().toISOString()
  const readAdapter = new HyperliquidAdapter({ walletAddress: context.config.walletAddress })
  const writeAdapter = context.config.privateKey
    ? new HyperliquidAdapter({ walletAddress: context.config.walletAddress, privateKey: context.config.privateKey })
    : readAdapter

  return {
    name: 'hyperliquid',
    version: '1.0.0',

    monitors: [
      {
        definition: {
          id: 'user-trades',
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
          id: 'perp-trading',
          name: 'Hyperliquid Perp Trading',
          description: 'Places, cancels, and manages perpetual orders on Hyperliquid',
          source: 'plugin',
          pluginName: 'hyperliquid',
          supportedActions: ['placeOrder', 'cancelOrder', 'setLeverage'],
          createdAt: now,
          updatedAt: now,
        },
        instance: new PerpTradingExecutor(writeAdapter),
      },
    ],

    strategies: [
      {
        definition: {
          id: 'copy-trading',
          name: 'Hyperliquid Copy Trading',
          description: "Mirrors another trader's perpetual positions at a configurable ratio",
          source: 'plugin',
          pluginName: 'hyperliquid',
          monitorIds: ['user-trades'],
          executorIds: ['perp-trading'],
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
