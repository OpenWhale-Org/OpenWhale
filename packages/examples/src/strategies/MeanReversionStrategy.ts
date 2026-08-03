import { BaseStrategy, OwStrategy, createLogger } from '@openwhaleorg/core'
import type { StrategyContext, StrategyParams, Trigger, StrategyDeclarations } from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { Kline } from '@openwhaleorg/exchange'
import { z } from 'zod'
import { zScore, signedExposure, sizeAgainstCap } from '../indicators.js'

const log = createLogger('MeanReversionStrategy')

/**
 * Z-score mean reversion — the counterpart to the breakout template.
 *
 * When the close sits more than `entryZ` standard deviations from its own
 * moving average, fade it: short the spike, buy the dip. Positions close as
 * the z-score decays back inside `exitZ`. Where the breakout strategy assumes
 * a move continues, this one assumes it snaps back — running both on the same
 * venue is the cheapest way to learn which regime you are in.
 *
 * VENUE-AGNOSTIC: no exchange is named. The venue comes from the perp account
 * bound to the `main` slot at activation.
 */
const decls = {
  monitors: [{ name: 'exchange/klines', label: 'candles' }],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],
} as const satisfies StrategyDeclarations

@OwStrategy({
  name: 'Mean Reversion (z-score)',
  description: 'Fades statistical extremes on any perp venue — enter beyond ±z, exit as the z-score decays',
})
export class MeanReversionStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'mean-reversion'

  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  readonly baseParamsSchema = z.object({
    symbol: z.string().meta({ displayName: 'Symbol', placeholder: 'ETH/USDT:USDT' }),
    timeframe: z.string().default('15m').meta({
      displayName: 'Timeframe', placeholder: '15m',
      description: 'Candle size; the klines monitor instance must collect this same timeframe',
    }),
    notionalUsd: z.number().positive().meta({ displayName: 'Order Notional (USD)', placeholder: '300' }),
    maxPositionUsd: z.number().positive().meta({
      displayName: 'Max Position (USD)', placeholder: '1500',
      description: 'Hard cap on |exposure| — a fade that keeps going is the classic way to die, so the cap is checked against the VENUE every evaluation',
    }),
  })

  readonly tunableParamsSchema = z.object({
    period: z.number().int().min(5).default(30)
      .meta({ displayName: 'Lookback (bars)', description: 'Window for the mean and deviation', slider: { min: 10, max: 200, step: 5 } }),
    entryZ: z.number().positive().default(2)
      .meta({ displayName: 'Entry |z|', description: 'Distance from the mean, in standard deviations, that counts as an extreme', slider: { min: 0.5, max: 4, step: 0.1 } }),
    exitZ: z.number().min(0).default(0.5)
      .meta({ displayName: 'Exit |z|', description: 'Flatten once the price is back within this many deviations', slider: { min: 0, max: 2, step: 0.1 } }),
    slippage: z.number().min(0).max(1).default(0.005)
      .meta({ displayName: 'Slippage Tolerance', description: 'Max slippage fraction for market orders' }),
  })

  private candleKey(params: StrategyParams): string {
    const { symbol, timeframe } = this.baseParamsSchema.parse(params.base)
    return `${this.accountVenue('main')}:${symbol}:${timeframe}`
  }

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return [{
      enabled: true,
      conditions: [{
        type: 'monitor',
        sources: [{ monitorName: this.monitor('candles'), key: this.candleKey(params) }],
      }],
    }]
  }

  async evaluate(_context: StrategyContext): Promise<ReturnType<BaseStrategy['instruction']>[]> {
    const { symbol, notionalUsd, maxPositionUsd } = this.baseParamsSchema.parse(this.params.base)
    const t = this.tunableParamsSchema.parse(this.params.tunable)
    const key = this.candleKey(this.params)

    const records = await this.monitorData('candles')?.readLast(key, t.period) ?? []
    if (records.length < t.period) {
      this.trace('candles:insufficient', { have: records.length, need: t.period })
      return []
    }

    const closes = records.map(r => (r.data as unknown as Kline).close)
    const z = zScore(closes, t.period)
    const close = closes[closes.length - 1]!
    if (z === undefined || !(close > 0)) return []

    const positions = await this.account('main').positions()
    const exposure = signedExposure(positions, symbol)
    this.trace('z-score', { z, close, exposure })

    // Inside the exit band: flatten whatever is open, then stand aside.
    if (Math.abs(z) <= t.exitZ) {
      if (exposure === 0) return []
      log.info({ symbol, z, exposure }, 'Reverted to the mean — flattening')
      return [this.instruction('perp', 'placeOrder', {
        symbol,
        side: exposure > 0 ? 'sell' : 'buy',
        type: 'market',
        amount: Math.abs(exposure) / close,
        reduceOnly: true,
        slippage: t.slippage,
      }, ['main'])]
    }

    if (Math.abs(z) < t.entryZ) return []

    // Fade the extreme: a high z-score is expensive, so sell it.
    const direction: 1 | -1 = z > 0 ? -1 : 1
    const { allowedUsd, reduceOnly } = sizeAgainstCap(notionalUsd, exposure, direction, maxPositionUsd)
    if (allowedUsd <= 0) {
      this.trace('sized-out', { z, exposure, maxPositionUsd })
      return []
    }

    log.info({ symbol, z, direction, allowedUsd, reduceOnly }, 'Fading an extreme')
    return [this.instruction('perp', 'placeOrder', {
      symbol,
      side: direction > 0 ? 'buy' : 'sell',
      type: 'market',
      amount: allowedUsd / close,
      ...(reduceOnly ? { reduceOnly: true } : {}),
      slippage: t.slippage,
    }, ['main'])]
  }
}
