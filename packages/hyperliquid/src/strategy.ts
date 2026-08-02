import { BaseStrategy, OwStrategy, createLogger } from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { StrategyContext, StrategyParams, Trigger, StrategyDeclarations } from '@openwhaleorg/core'
import { z } from 'zod'

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
 *   - account: hyperliquid
 *   - executor: 'perp-trading' (PerpTradingExecutor)
 */
// Declared once, typed everywhere: labels in monitor()/executor()/account()/
// instruction() autocomplete and reject typos at compile time.
const decls = {
  monitors: [{ name: 'user-trades', label: 'trades' }],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],   // shared executor from @openwhaleorg/exchange
  accounts: [{ account: PerpAccount, label: 'main' }],             // any perp venue's Reader
} as const satisfies StrategyDeclarations

@OwStrategy({
  name: 'Hyperliquid Copy Trading',
  description: "Mirrors another trader's perpetual fills at a configurable ratio — executes on any bound perp venue",
})
export class CopyTradingStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'copy-trading'

  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

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
            sources: [{ monitorName: this.monitor('trades'), key: targetAddress }],
          },
        ],
      },
    ]
  }

  async evaluate(context: StrategyContext): Promise<ReturnType<BaseStrategy['instruction']>[]> {
    const { targetAddress, ratio, maxPositionUsd } = this.baseParamsSchema.parse(this.params.base)
    const { minTradeUsd, slippageTolerance } = this.tunableParamsSchema.parse(this.params.tunable)

    log.debug({ triggerId: context.triggerId, targetAddress }, 'Evaluate triggered')

    const tradeData = context.getData('trades', targetAddress)
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

    // Signed exposure: long positive, short negative. The cap applies to both directions.
    // Note: REST position data lags recent fills slightly; maxPositionUsd is a soft
    // cap under a rapid burst of trades from the target.
    const account = this.account('main')
    const positions = await account.positions()
    const existing = positions.find(p => p.id === trade.symbol)
    const signedExposure = existing ? (existing.side === 'short' ? -existing.value : existing.value) : 0
    const tradeDelta = (trade.side === 'buy' ? 1 : -1) * copyNotional
    const isReducing = signedExposure !== 0 && Math.sign(tradeDelta) !== Math.sign(signedExposure)

    log.debug({ symbol: trade.symbol, signedExposure, tradeDelta, isReducing, maxPositionUsd }, 'Current position check')

    let allowedNotional: number
    let reduceOnly = false
    if (isReducing) {
      // Mirroring a close: never flip through zero into an opposite position.
      allowedNotional = Math.min(copyNotional, Math.abs(signedExposure))
      reduceOnly = true
    } else {
      // Increasing exposure (same direction or from flat): only the remaining headroom.
      const headroom = maxPositionUsd - Math.abs(signedExposure)
      allowedNotional = Math.min(copyNotional, Math.max(0, headroom))
    }

    if (allowedNotional < copyNotional)
      log.info({ copyNotional, allowedNotional, maxPositionUsd, reduceOnly }, 'Notional capped')

    // minTradeUsd filters noise on new exposure only. Reducing orders are capped
    // at |signedExposure|, so applying the floor to them would make a residual
    // position below minTradeUsd permanently unclosable.
    if (!reduceOnly && allowedNotional < minTradeUsd) {
      log.info({ symbol: trade.symbol, allowedNotional, minTradeUsd }, 'Allowed notional below minTradeUsd — skipping')
      return []
    }
    if (allowedNotional <= 0) {
      log.info({ symbol: trade.symbol }, 'No allowed notional — skipping')
      return []
    }

    const copyAmount = allowedNotional / trade.price

    const instruction = this.instruction('perp', 'placeOrder', {
      symbol: trade.symbol,
      side: trade.side,
      type: 'market',
      amount: copyAmount,
      reduceOnly,
      slippage: slippageTolerance,
    }, ['main'])

    log.info(
      { symbol: trade.symbol, side: trade.side, amount: copyAmount, allowedNotional, reduceOnly, slippageTolerance },
      'Emitting placeOrder instruction',
    )

    return [instruction]
  }
}
