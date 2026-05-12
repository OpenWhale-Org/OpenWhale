import { BaseStrategy } from '@openwhale/core'
import type { StrategyContext, StrategyParams, ExecutionInstruction, Trigger } from '@openwhale/core'
import { z } from 'zod'
import { nanoid } from 'nanoid'

/**
 * CopyTradingStrategy
 *
 * Monitors a target wallet address on Hyperliquid and mirrors its trades
 * proportionally to the configured account.
 *
 * baseParams:
 *   - targetAddress: wallet address to copy
 *   - ratio: fraction of target's trade size to replicate (e.g. 0.5 = 50%)
 *   - maxPositionUsd: hard cap on any single position value in USD
 *
 * Requires:
 *   - monitor: 'user-trades' (UserTradesMonitor)
 *   - account: hyperliquid (HyperliquidAccount)
 *   - executor: 'perp-trading' (PerpTradingExecutor)
 */
export class CopyTradingStrategy extends BaseStrategy {
  readonly strategyId = 'copy-trading'

  readonly monitors = ['user-trades'] as const

  readonly accountTypes = [{ type: 'hyperliquid', label: 'main' }] as const

  readonly baseParamsSchema = z.object({
    targetAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid EVM address'),
    ratio: z.number().positive().max(10),
    maxPositionUsd: z.number().positive(),
  })

  readonly tunableParamsSchema = z.object({
    minTradeUsd: z.number().positive().default(10),
    slippageTolerance: z.number().min(0).max(1).default(0.005),
  })

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const { targetAddress } = this.baseParamsSchema.parse(params.base)
    return [
      {
        enabled: true,
        conditions: [
          {
            type: 'monitor',
            sources: [{ monitorName: 'user-trades', key: targetAddress }],
          },
        ],
      },
    ]
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const { targetAddress, ratio, maxPositionUsd } = this.baseParamsSchema.parse(this.params.base)
    const { minTradeUsd } = this.tunableParamsSchema.parse(this.params.tunable)

    // The monitor emits one trade per event — retrieve it from monitorData
    const tradeData = context.monitorData[`user-trades:${targetAddress}`]
    if (!tradeData) return []

    const trade = tradeData as {
      symbol: string
      side: 'buy' | 'sell'
      price: number
      amount: number
      cost: number
      takerOrMaker: string
    }

    // Calculate copy size
    const targetNotional = trade.cost > 0 ? trade.cost : trade.price * trade.amount
    const copyNotional = targetNotional * ratio

    if (copyNotional < minTradeUsd) return []

    const cappedNotional = Math.min(copyNotional, maxPositionUsd)
    const copyAmount = cappedNotional / trade.price

    // Check existing position to avoid over-sizing
    const account = this.account('main')
    const positions = await account.positions()
    const existing = positions.find(p => p.id === trade.symbol)
    const existingValue = existing?.value ?? 0

    // If already at or above cap on this side, skip
    if (trade.side === 'buy' && existingValue >= maxPositionUsd) return []

    return [
      {
        executorId: 'perp-trading',
        messageId: nanoid(),
        action: 'placeOrder',
        params: {
          symbol: trade.symbol,
          side: trade.side,
          type: 'market',
          amount: parseFloat(copyAmount.toFixed(6)),
        },
      },
    ]
  }
}
