import { BaseStrategy, OwStrategy, createLogger } from '@openwhaleorg/core'
import type { StrategyContext, StrategyParams, Trigger, StrategyDeclarations, MonitorSource } from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { Kline } from '@openwhaleorg/exchange'
import { z } from 'zod'
import { atr, signedExposure, sizeAgainstCap } from '../indicators.js'

const log = createLogger('AiAnalystStrategy')

/**
 * LLM-driven discretionary trading — the model reads the tape, the CODE
 * decides how much money is at stake.
 *
 * Every scheduled tick this strategy hands the model a compact market summary
 * (recent candles, realized volatility, current exposure) and asks for one
 * structured verdict. The verdict is advisory: conviction scales the clip
 * between zero and `notionalUsd`, and the same position cap that guards the
 * mechanical strategies applies unchanged. The model can never name a size,
 * a symbol, or a venue — it only picks a direction and how sure it is.
 *
 * That split is the point of the example. An LLM in the decision path is
 * useful; an LLM in the risk path is a liability.
 *
 * Requires an `llm` credential (Anthropic / OpenAI / …) bound to the
 * `decision` slot; the model is overridable per instance from the dashboard.
 */
const decls = {
  monitors: [{ name: 'exchange/klines', label: 'candles' }],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],
  llms: [{ label: 'decision', model: 'anthropic:claude-haiku-4-5' }],
} as const satisfies StrategyDeclarations

/** What the model is allowed to say. Anything else is a schema violation, retried by the SDK. */
const verdictSchema = z.object({
  action: z.enum(['buy', 'sell', 'hold']).describe('buy = increase long exposure, sell = increase short / reduce long, hold = no order'),
  confidence: z.number().min(0).max(1).describe('0 = coin flip, 1 = certain. Scales the order size'),
  reason: z.string().max(280).describe('One sentence, for the run trace'),
})

@OwStrategy({
  name: 'AI Market Analyst',
  description: 'An LLM reads recent candles and returns a structured verdict; code enforces sizing and position caps. Any perp venue, any model',
})
export class AiAnalystStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'ai-analyst'

  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts
  override readonly llms = decls.llms

  readonly baseParamsSchema = z.object({
    symbol: z.string().meta({ displayName: 'Symbol', placeholder: 'BTC/USDT:USDT' }),
    timeframe: z.string().default('1h').meta({
      displayName: 'Timeframe', placeholder: '1h',
      description: 'Candle size; the klines monitor instance must collect this same timeframe',
    }),
    notionalUsd: z.number().positive().meta({
      displayName: 'Max Order Notional (USD)', placeholder: '200',
      description: 'Clip size at FULL confidence — the model scales down from here, never up',
    }),
    maxPositionUsd: z.number().positive().meta({
      displayName: 'Max Position (USD)', placeholder: '1000',
      description: 'Hard cap on |exposure|, enforced in code regardless of what the model says',
    }),
  })

  readonly tunableParamsSchema = z.object({
    schedule: z.string().min(1).default('0 */15 * * * *')
      .meta({ displayName: 'Schedule (cron)', description: '6-field cron. Default: every 15 minutes — each tick costs one model call' }),
    candleCount: z.number().int().min(10).max(200).default(48)
      .meta({ displayName: 'Candles in Prompt', description: 'How much history the model sees', slider: { min: 10, max: 200, step: 1 } }),
    minConfidence: z.number().min(0).max(1).default(0.6)
      .meta({ displayName: 'Min Confidence', description: 'Verdicts below this are logged and ignored', slider: { min: 0, max: 1, step: 0.05 } }),
    guidance: z.string().default('')
      .meta({
        displayName: 'Extra Guidance',
        description: 'Optional free text appended to the prompt — house style, risk posture, things to avoid',
      }),
    slippage: z.number().min(0).max(1).default(0.005)
      .meta({ displayName: 'Slippage Tolerance', description: 'Max slippage fraction for market orders' }),
  })

  private candleKey(params: StrategyParams): string {
    const { symbol, timeframe } = this.baseParamsSchema.parse(params.base)
    return `${this.accountVenue('main')}:${symbol}:${timeframe}`
  }

  /** Collect candles continuously; the cron decides when to think about them. */
  override subscriptions(params: StrategyParams): MonitorSource[] {
    return [{ monitorName: this.monitor('candles'), key: this.candleKey(params) }]
  }

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const { schedule } = this.tunableParamsSchema.parse(params.tunable)
    return [{ enabled: true, conditions: [{ type: 'cron', expression: schedule }] }]
  }

  async evaluate(_context: StrategyContext): Promise<ReturnType<BaseStrategy['instruction']>[]> {
    const { symbol, timeframe, notionalUsd, maxPositionUsd } = this.baseParamsSchema.parse(this.params.base)
    const t = this.tunableParamsSchema.parse(this.params.tunable)
    const key = this.candleKey(this.params)

    const records = await this.monitorData('candles')?.readLast(key, t.candleCount) ?? []
    if (records.length < 10) {
      this.trace('candles:insufficient', { have: records.length })
      return []
    }
    const bars = records.map(r => r.data as unknown as Kline)
    const close = bars[bars.length - 1]!.close
    if (!(close > 0)) return []

    const positions = await this.account('main').positions()
    const exposure = signedExposure(positions, symbol)
    const volatility = atr(bars.map(b => b.high), bars.map(b => b.low), bars.map(b => b.close), Math.min(14, bars.length - 1))

    // A compact, machine-readable brief beats prose: fewer tokens, less room
    // for the model to hallucinate structure that is not there.
    const brief = [
      `symbol=${symbol} timeframe=${timeframe}`,
      `last_close=${close}`,
      volatility !== undefined ? `atr14=${volatility.toFixed(6)} (${(volatility / close * 100).toFixed(2)}% of price)` : '',
      `current_exposure_usd=${exposure.toFixed(2)} (positive=long, negative=short)`,
      `max_position_usd=${maxPositionUsd}`,
      '',
      'candles (oldest first) as time,open,high,low,close,volume:',
      ...bars.map(b => `${new Date(b.timestamp).toISOString()},${b.open},${b.high},${b.low},${b.close},${b.volume}`),
    ].filter(Boolean).join('\n')

    const verdict = await this.llm('decision', {
      messages: [
        {
          role: 'system',
          content: [
            'You are a disciplined systematic trader reviewing one market on a fixed schedule.',
            'Answer with a direction and your confidence. You do NOT choose size — the system scales your confidence into a capped clip.',
            'Prefer "hold" when the tape is unclear: doing nothing is free, being wrong is not.',
            'Consider existing exposure: adding to a position that is already at its cap achieves nothing.',
            t.guidance.trim(),
          ].filter(Boolean).join(' '),
        },
        { role: 'user', content: brief },
      ],
      schema: verdictSchema,
    })

    this.trace('verdict', verdict)
    log.info({ symbol, ...verdict, exposure }, 'Model verdict')

    if (verdict.action === 'hold' || verdict.confidence < t.minConfidence) return []

    // Confidence scales the clip; the cap has the final word.
    const direction: 1 | -1 = verdict.action === 'buy' ? 1 : -1
    const wanted = notionalUsd * verdict.confidence
    const { allowedUsd, reduceOnly } = sizeAgainstCap(wanted, exposure, direction, maxPositionUsd)
    if (allowedUsd <= 0) {
      this.trace('sized-out', { wanted, exposure, maxPositionUsd })
      return []
    }

    return [this.instruction('perp', 'placeOrder', {
      symbol,
      side: verdict.action,
      type: 'market',
      amount: allowedUsd / close,
      ...(reduceOnly ? { reduceOnly: true } : {}),
      slippage: t.slippage,
    }, ['main'])]
  }
}
