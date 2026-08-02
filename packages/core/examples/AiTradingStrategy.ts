/**
 * Example: AiTradingStrategy
 *
 * LLM-assisted decision strategy — feeds market data to an LLM and receives structured trading recommendations.
 *
 * Trigger: Cron-driven (runs once per minute)
 *
 * Logic:
 * 1. Read the latest price and recent history for multiple trading pairs
 * 2. Build a prompt and call the LLM to analyze market state
 * 3. LLM returns a structured decision (validated by Zod schema)
 * 4. Generate trade instructions based on the decision
 *
 * Key points:
 * - baseParamsSchema declares watchlist (required); triggers() returns a cron trigger
 * - monitors declares monitor dependencies; TriggerManager injects readers at start()
 * - monitorData('price') returns a reader; use readLatest(key) / readLast(key, n) to access data
 * - llm({ schema }) return type is inferred from the Zod schema — fully type-safe
 * - step() caches the LLM call result to avoid duplicate calls within a single evaluate
 */

import { z } from 'zod'
import { BaseStrategy } from '../src/strategy/BaseStrategy.js'
import type { StrategyContext, StrategyOptions } from '../src/types/strategy.js'
import type { StrategyParams } from '../src/types/instance.js'
import type { ExecutionInstruction } from '../src/types/executor.js'
import type { Trigger } from '../src/types/trigger.js'

// ── LLM output schema ─────────────────────────────────────────────────────────

const marketAnalysisSchema = z.object({
  sentiment:  z.enum(['bullish', 'bearish', 'neutral']),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.object({
    symbol:  z.string(),
    action:  z.enum(['buy', 'sell', 'hold']),
    reason:  z.string(),
    urgency: z.enum(['high', 'medium', 'low']),
  })),
  summary: z.string(),
})

type MarketAnalysis = z.infer<typeof marketAnalysisSchema>

// ── Strategy implementation ───────────────────────────────────────────────────

export class AiTradingStrategy extends BaseStrategy {
  readonly strategyId = 'ai-trading'
  readonly monitors   = ['price']

  readonly baseParamsSchema = z.object({
    watchlist: z.array(z.string()),  // e.g. ['BTC', 'ETH', 'SOL']
  })

  constructor(options?: StrategyOptions) {
    super(options ?? {
      llm: { defaultModel: 'openai:gpt-4o-mini' },
    })
  }

  triggers(_params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return [{
      enabled: true,
      conditions: [{ type: 'cron', expression: '* * * * *' }],  // every minute
    }]
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const { watchlist } = this.params.base as { watchlist: string[] }

    // collect market data for all trading pairs
    const marketData = await this.step('market-data', () => this.collectMarketData(watchlist))
    if (Object.keys(marketData).length === 0) return []

    // call LLM for analysis; result is validated and typed by the Zod schema
    const analysis = await this.step('llm-analysis', () =>
      this.llm({
        messages: [
          {
            role: 'system',
            content: [
              'You are a professional crypto trading analyst.',
              'Based on the provided market data, give a trading recommendation for each pair.',
              'Only suggest buy/sell when confidence is high (>0.7); otherwise suggest hold.',
              'Your response must strictly follow the JSON schema with no extra fields.',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({ timestamp: context.timestamp, marketData }),
          },
        ],
        schema: marketAnalysisSchema,
        // optional: override the default model
        // model: 'anthropic:claude-3-5-haiku-20241022',
      })
    )

    // only execute when confidence is high enough
    if (analysis.confidence < 0.6) return []

    return this.parallel(
      analysis.signals
        .filter(s => s.action !== 'hold' && s.urgency !== 'low')
        .map(signal => this.signalToInstructions(signal, analysis))
    )
  }

  private signalToInstructions(
    signal: MarketAnalysis['signals'][number],
    analysis: MarketAnalysis,
  ): ExecutionInstruction[] {
    const baseAmount = analysis.confidence > 0.85 ? 200 : 100  // larger position at high confidence

    if (signal.action === 'buy')
      return [{ executorId: 'trade', messageId: '', action: 'buy', params: { symbol: signal.symbol, quoteAmount: baseAmount } }]

    if (signal.action === 'sell')
      return [{ executorId: 'trade', messageId: '', action: 'sell', params: { symbol: signal.symbol, baseAmount: 0.01 } }]

    return []
  }

  private async collectMarketData(watchlist: string[]): Promise<Record<string, unknown>> {
    const reader = this.monitorData('price')
    if (!reader) return {}

    const result: Record<string, unknown> = {}
    for (const symbol of watchlist) {
      const latest  = await reader.readLatest(symbol)
      const history = await reader.readLast(symbol, 10)
      if (latest) result[symbol] = { latest, history }
    }
    return result
  }
}
