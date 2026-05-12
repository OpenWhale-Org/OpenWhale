import { BaseStrategy, createLogger } from '@openwhale/core'
import type { StrategyContext, StrategyParams, ExecutionInstruction, Trigger } from '@openwhale/core'
import { z } from 'zod'
import { nanoid } from 'nanoid'

const log = createLogger('CopyTradingStrategy')

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
    targetAddress: z.string()
      .regex(/^0x[0-9a-fA-F]{40}$/, 'Must be a valid EVM address')
      .meta({ displayName: 'Target Address', placeholder: '0x...', description: 'Wallet address to copy trades from' }),
    ratio: z.number().positive().max(10)
      .meta({ displayName: 'Ratio', placeholder: '0.5', description: "Fraction of the target's trade size to replicate (e.g. 0.5 = 50%)" }),
    maxPositionUsd: z.number().positive()
      .meta({ displayName: 'Max Position USD', placeholder: '1000', description: 'Hard cap on any single position value in USD' }),
  })

  readonly tunableParamsSchema = z.object({
    minTradeUsd: z.number().positive().default(10)
      .meta({ displayName: 'Min Trade USD', placeholder: '10', description: 'Trades below this notional value are ignored' }),
    slippageTolerance: z.number().min(0).max(1).default(0.005)
      .meta({ displayName: 'Slippage Tolerance', placeholder: '0.005', description: 'Max slippage fraction for market orders (e.g. 0.005 = 0.5%)' }),
  })

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const { targetAddress } = this.baseParamsSchema.parse(params.base)
    log.debug({ targetAddress }, 'Registering monitor trigger')
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
    const { minTradeUsd, slippageTolerance } = this.tunableParamsSchema.parse(this.params.tunable)

    log.debug({ triggerId: context.triggerId, targetAddress }, 'Evaluate triggered')

    // The monitor emits one trade per event — retrieve it from monitorData
    const tradeData = context.monitorData[`user-trades:${targetAddress}`]
    if (!tradeData) {
      log.warn({ triggerId: context.triggerId }, 'No trade data in context — skipping')
      return []
    }

    const trade = tradeData as {
      symbol: string
      side: 'buy' | 'sell'
      price: number
      amount: number
      cost: number
      takerOrMaker: string
    }

    log.info(
      { symbol: trade.symbol, side: trade.side, price: trade.price, amount: trade.amount, cost: trade.cost },
      'Processing trade from target',
    )

    // Calculate copy size
    const targetNotional = trade.cost > 0 ? trade.cost : trade.price * trade.amount
    const copyNotional = targetNotional * ratio
    log.debug({ targetNotional, ratio, copyNotional, minTradeUsd }, 'Notional calculation')

    if (copyNotional < minTradeUsd) {
      log.info({ copyNotional, minTradeUsd }, 'Trade below minTradeUsd — skipping')
      return []
    }

    const cappedNotional = Math.min(copyNotional, maxPositionUsd)
    const copyAmount = cappedNotional / trade.price

    if (cappedNotional < copyNotional)
      log.info({ copyNotional, cappedNotional, maxPositionUsd }, 'Notional capped by maxPositionUsd')

    // Check existing position to avoid over-sizing
    const account = this.account('main')
    const positions = await account.positions()
    const existing = positions.find(p => p.id === trade.symbol)
    const existingValue = existing?.value ?? 0

    log.debug({ symbol: trade.symbol, existingValue, maxPositionUsd }, 'Current position check')

    if (trade.side === 'buy' && existingValue >= maxPositionUsd) {
      log.info({ symbol: trade.symbol, existingValue, maxPositionUsd }, 'Position at cap — skipping buy')
      return []
    }

    const instruction: ExecutionInstruction = {
      executorId: 'perp-trading',
      messageId: nanoid(),
      action: 'placeOrder',
      params: {
        symbol: trade.symbol,
        side: trade.side,
        type: 'market',
        amount: parseFloat(copyAmount.toFixed(6)),
        slippage: slippageTolerance,
      },
    }

    log.info(
      { symbol: trade.symbol, side: trade.side, amount: instruction.params.amount, cappedNotional, slippageTolerance },
      'Emitting placeOrder instruction',
    )

    return [instruction]
  }
}
