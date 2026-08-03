import { BaseStrategy, OwStrategy, createLogger } from '@openwhaleorg/core'
import type { StrategyContext, StrategyParams, Trigger, StrategyDeclarations } from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { ExchangeTrade } from '@openwhaleorg/exchange'
import { z } from 'zod'
import { signedExposure, sizeAgainstCap } from '../indicators.js'

const log = createLogger('CopyTradingStrategy')

/**
 * Copy trading — mirror another trader's fills at a fraction of their size.
 *
 * The feed is `hyperliquid/user-trades`, which streams the fills of ANY
 * address (Hyperliquid publishes them; most venues do not — that is why the
 * monitor lives in the venue plugin). Execution is venue-agnostic: the orders
 * go through the shared perp executor on whichever account you bind, so you
 * can copy a Hyperliquid trader onto Binance if the symbols line up.
 *
 * Install `@openwhaleorg/hyperliquid` alongside this package — the monitor is
 * referenced by its qualified id and must be registered for activation to
 * succeed.
 */
const decls = {
  monitors: [{ name: 'hyperliquid/user-trades', label: 'trades' }],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],
} as const satisfies StrategyDeclarations

@OwStrategy({
  name: 'Copy Trading',
  description: "Mirrors another trader's perpetual fills at a configurable ratio — feed from Hyperliquid, execution on any bound perp venue",
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
      .meta({ displayName: 'Ratio', placeholder: '0.5', description: "Fraction of the target's trade size to replicate (0.5 = half)" }),
    maxPositionUsd: z.number().positive()
      .meta({ displayName: 'Max Position (USD)', placeholder: '1000', description: 'Hard cap on |exposure| per symbol' }),
  })

  readonly tunableParamsSchema = z.object({
    minTradeUsd: z.number().positive().default(10)
      .meta({ displayName: 'Min Trade (USD)', description: 'Ignore mirrored notionals below this — noise filter for new exposure only' }),
    slippage: z.number().min(0).max(1).default(0.005)
      .meta({ displayName: 'Slippage Tolerance', description: 'Max slippage fraction for market orders' }),
  })

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const { targetAddress } = this.baseParamsSchema.parse(params.base)
    return [{
      enabled: true,
      conditions: [{
        type: 'monitor',
        sources: [{ monitorName: this.monitor('trades'), key: targetAddress }],
      }],
    }]
  }

  async evaluate(context: StrategyContext): Promise<ReturnType<BaseStrategy['instruction']>[]> {
    const { targetAddress, ratio, maxPositionUsd } = this.baseParamsSchema.parse(this.params.base)
    const { minTradeUsd, slippage } = this.tunableParamsSchema.parse(this.params.tunable)

    const trade = context.getData('trades', targetAddress) as ExchangeTrade | undefined
    if (!trade) {
      this.trace('trade:missing', { targetAddress })
      return []
    }

    const targetNotional = trade.cost > 0 ? trade.cost : trade.price * trade.amount
    const copyNotional = targetNotional * ratio
    this.trace('mirror', { symbol: trade.symbol, side: trade.side, targetNotional, copyNotional })
    if (copyNotional < minTradeUsd) return []

    // Position data lags a burst of fills slightly, so the cap is a soft one —
    // it still bounds a runaway target, which is what it exists for.
    const positions = await this.account('main').positions()
    const exposure = signedExposure(positions, trade.symbol)
    const direction: 1 | -1 = trade.side === 'buy' ? 1 : -1
    const { allowedUsd, reduceOnly } = sizeAgainstCap(copyNotional, exposure, direction, maxPositionUsd)

    // The floor filters NEW exposure only: applying it to reductions would
    // strand a residual position below minTradeUsd forever.
    if (allowedUsd <= 0 || (!reduceOnly && allowedUsd < minTradeUsd)) {
      this.trace('sized-out', { copyNotional, allowedUsd, exposure, reduceOnly })
      return []
    }

    log.info(
      { symbol: trade.symbol, side: trade.side, allowedUsd, reduceOnly, price: trade.price },
      'Mirroring a fill',
    )
    return [this.instruction('perp', 'placeOrder', {
      symbol: trade.symbol,
      side: trade.side,
      type: 'market',
      amount: allowedUsd / trade.price,
      ...(reduceOnly ? { reduceOnly: true } : {}),
      slippage,
    }, ['main'])]
  }
}
