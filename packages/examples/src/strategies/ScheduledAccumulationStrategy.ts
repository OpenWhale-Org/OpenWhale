import { BaseStrategy, OwStrategy, createLogger } from '@openwhaleorg/core'
import type {
  StrategyContext, StrategyParams, Trigger, StrategyDeclarations, MonitorSource,
} from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { Ticker } from '@openwhaleorg/exchange'
import { z } from 'zod'
import { sma, signedExposure } from '../indicators.js'

const log = createLogger('ScheduledAccumulationStrategy')

/**
 * Scheduled accumulation (DCA) — the simplest useful strategy, and the
 * cleanest demonstration of a CRON-driven evaluate.
 *
 * Every `schedule` tick it buys a fixed USD clip, optionally larger when the
 * price is below its own moving average ("buy more when it is cheaper"), and
 * stops once the position reaches `targetUsd`. There is no exit: accumulation
 * is the whole strategy, and exiting is a decision for a human or another
 * instance.
 *
 * Note the two-monitor pattern: the ticker feed is DECLARED and SUBSCRIBED
 * (so the price series keeps filling) but it never triggers evaluate — the
 * cron does. `subscriptions()` is how a strategy says "keep collecting this,
 * but do not wake me for it".
 */
const decls = {
  monitors: [{ name: 'exchange/ticker', label: 'price' }],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],
} as const satisfies StrategyDeclarations

@OwStrategy({
  name: 'Scheduled Accumulation (DCA)',
  description: 'Buys a fixed USD clip on a cron schedule until a target position is reached — bigger clips below the average',
})
export class ScheduledAccumulationStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'scheduled-accumulation'

  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  readonly baseParamsSchema = z.object({
    symbol: z.string().meta({ displayName: 'Symbol', placeholder: 'BTC/USDT:USDT' }),
    usdPerBuy: z.number().positive().meta({
      displayName: 'USD per Buy', placeholder: '100',
      description: 'Base clip size for each scheduled purchase',
    }),
    targetUsd: z.number().positive().meta({
      displayName: 'Target Position (USD)', placeholder: '5000',
      description: 'Accumulate up to this exposure, then idle',
    }),
  })

  readonly tunableParamsSchema = z.object({
    schedule: z.string().min(1).default('0 0 */4 * * *')
      .meta({
        displayName: 'Schedule (cron)',
        description: '6-field cron (sec min hour day month weekday). Default: every 4 hours on the hour',
      }),
    dipLookback: z.number().int().min(0).default(24)
      .meta({ displayName: 'Dip Lookback (samples)', description: 'Ticker samples averaged for the "is it cheap" test. 0 disables dip sizing' }),
    dipMultiplier: z.number().min(1).default(2)
      .meta({ displayName: 'Dip Multiplier', description: 'Clip multiplier when the price is below the average', slider: { min: 1, max: 5, step: 0.25 } }),
    slippage: z.number().min(0).max(1).default(0.005)
      .meta({ displayName: 'Slippage Tolerance', description: 'Max slippage fraction for market orders' }),
  })

  private priceKey(params: StrategyParams): string {
    const { symbol } = this.baseParamsSchema.parse(params.base)
    return `${this.accountVenue('main')}:${symbol}`
  }

  /** Keep the ticker collecting without waking evaluate — the cron owns the cadence. */
  override subscriptions(params: StrategyParams): MonitorSource[] {
    return [{ monitorName: this.monitor('price'), key: this.priceKey(params) }]
  }

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const { schedule } = this.tunableParamsSchema.parse(params.tunable)
    return [{ enabled: true, conditions: [{ type: 'cron', expression: schedule }] }]
  }

  async evaluate(_context: StrategyContext): Promise<ReturnType<BaseStrategy['instruction']>[]> {
    const { symbol, usdPerBuy, targetUsd } = this.baseParamsSchema.parse(this.params.base)
    const t = this.tunableParamsSchema.parse(this.params.tunable)
    const key = this.priceKey(this.params)

    const latest = await this.monitorData('price')?.readLatest(key)
    const price = (latest?.data as unknown as Ticker | undefined)?.last
    if (!price || price <= 0) {
      this.trace('price:missing', { key })
      return []
    }

    const positions = await this.account('main').positions()
    const exposure = signedExposure(positions, symbol)
    const headroom = targetUsd - Math.max(0, exposure)
    if (headroom <= 0) {
      this.trace('target:reached', { exposure, targetUsd })
      return []
    }

    // Cheap relative to its own recent average → take a bigger bite.
    let clip = usdPerBuy
    if (t.dipLookback > 0) {
      const samples = await this.monitorData('price')?.readLast(key, t.dipLookback) ?? []
      const average = sma(samples.map(r => (r.data as unknown as Ticker).last), t.dipLookback)
      if (average !== undefined && price < average) {
        clip = usdPerBuy * t.dipMultiplier
        this.trace('dip', { price, average, clip })
      }
    }
    // Never overshoot the target on the final clip.
    const usd = Math.min(clip, headroom)

    log.info({ symbol, usd, price, exposure, targetUsd }, 'Scheduled buy')
    return [this.instruction('perp', 'placeOrder', {
      symbol,
      side: 'buy',
      type: 'market',
      amount: usd / price,
      slippage: t.slippage,
    }, ['main'])]
  }
}
