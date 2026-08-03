import { BaseStrategy, OwStrategy, createLogger } from '@openwhaleorg/core'
import type { StrategyContext, StrategyParams, Trigger, StrategyDeclarations } from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { Kline } from '@openwhaleorg/exchange'
import { z } from 'zod'
import { donchian, signedExposure, sizeAgainstCap } from '../indicators.js'

const log = createLogger('MomentumBreakoutStrategy')

/**
 * Donchian breakout — the canonical trend-following template.
 *
 * A close above the highest high of the previous `entryLookback` bars opens
 * (or extends) a long; a close below the lowest low of the previous
 * `exitLookback` bars closes it, and optionally opens a short. Entry and exit
 * lookbacks are separate on purpose: a slow entry filters noise, a fast exit
 * gives the trend back less of what it gave you.
 *
 * VENUE-AGNOSTIC: the strategy names no exchange. It reads the shared
 * `exchange/klines` monitor and trades through the shared
 * `exchange/perp-trading` executor; the venue comes from whichever perp
 * account you bind to the `main` slot at activation.
 */
const decls = {
  monitors: [{ name: 'exchange/klines', label: 'candles' }],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],
} as const satisfies StrategyDeclarations

@OwStrategy({
  name: 'Momentum Breakout',
  description: 'Donchian channel breakout on any perp venue — long above the channel, exit (or flip) below it',
})
export class MomentumBreakoutStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'momentum-breakout'

  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  readonly baseParamsSchema = z.object({
    symbol: z.string().meta({
      displayName: 'Symbol', placeholder: 'BTC/USDT:USDT',
      description: 'Contract to trade — must match a key of the klines monitor instance',
    }),
    timeframe: z.string().default('1h').meta({
      displayName: 'Timeframe', placeholder: '1h',
      description: 'Candle size; the klines monitor instance must collect this same timeframe',
    }),
    notionalUsd: z.number().positive().meta({
      displayName: 'Order Notional (USD)', placeholder: '500',
      description: 'USD notional per entry order',
    }),
    maxPositionUsd: z.number().positive().meta({
      displayName: 'Max Position (USD)', placeholder: '2000',
      description: 'Hard cap on |exposure| for this symbol — checked against the venue, not against what this strategy thinks it opened',
    }),
  })

  readonly tunableParamsSchema = z.object({
    entryLookback: z.number().int().min(2).default(20)
      .meta({ displayName: 'Entry Lookback (bars)', description: 'Breakout channel length for entries', slider: { min: 5, max: 100, step: 1 } }),
    exitLookback: z.number().int().min(2).default(10)
      .meta({ displayName: 'Exit Lookback (bars)', description: 'Shorter channel for exits — trends give back less', slider: { min: 2, max: 50, step: 1 } }),
    allowShort: z.boolean().default(false)
      .meta({ displayName: 'Allow Shorts', description: 'Open a short on a downside breakout instead of only flattening' }),
    slippage: z.number().min(0).max(1).default(0.005)
      .meta({ displayName: 'Slippage Tolerance', description: 'Max slippage fraction for market orders (0.005 = 0.5%)' }),
  })

  /** Klines are keyed venue:symbol:timeframe — the venue derives from the bound account. */
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

    // One read of the longer window serves both channels.
    const need = Math.max(t.entryLookback, t.exitLookback) + 1
    const records = await this.monitorData('candles')?.readLast(key, need) ?? []
    if (records.length < need) {
      this.trace('candles:insufficient', { have: records.length, need })
      return []
    }

    const bars = records.map(r => r.data as unknown as Kline)
    const highs = bars.map(b => b.high)
    const lows = bars.map(b => b.low)
    const close = bars[bars.length - 1]!.close
    const entry = donchian(highs, lows, t.entryLookback)
    const exit = donchian(highs, lows, t.exitLookback)
    if (!entry || !exit || !(close > 0)) return []

    const positions = await this.account('main').positions()
    const exposure = signedExposure(positions, symbol)
    this.trace('channels', { close, entry, exit, exposure })

    // Direction first, sizing second — and sizing is always the cap's call.
    let direction: 1 | -1 | 0 = 0
    if (close > entry.upper) direction = 1
    else if (close < exit.lower && exposure > 0) direction = -1        // exit a long
    else if (close < entry.lower && t.allowShort) direction = -1       // or open a short
    else if (close > exit.upper && exposure < 0) direction = 1         // cover a short
    if (direction === 0) return []

    const { allowedUsd, reduceOnly } = sizeAgainstCap(notionalUsd, exposure, direction, maxPositionUsd)
    if (allowedUsd <= 0) {
      this.trace('sized-out', { direction, exposure, maxPositionUsd })
      return []
    }
    // A reduction sweeps whatever is open; an entry uses the configured clip.
    const usd = reduceOnly ? Math.abs(exposure) : allowedUsd

    log.info({ symbol, direction, usd, reduceOnly, close }, 'Breakout signal')
    return [this.instruction('perp', 'placeOrder', {
      symbol,
      side: direction > 0 ? 'buy' : 'sell',
      type: 'market',
      amount: usd / close,
      ...(reduceOnly ? { reduceOnly: true } : {}),
      slippage: t.slippage,
    }, ['main'])]
  }
}
