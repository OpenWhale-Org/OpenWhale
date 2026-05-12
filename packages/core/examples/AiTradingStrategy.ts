/**
 * Example: AiTradingStrategy
 *
 * LLM 辅助决策策略 — 将市场数据喂给 LLM，由 AI 给出结构化交易建议。
 *
 * 触发方式：Cron 触发（每分钟运行一次）
 *
 * 逻辑：
 * 1. 读取多个交易对的最新价格和近期历史
 * 2. 构造 prompt，调用 LLM 分析市场状态
 * 3. LLM 返回结构化决策（Zod schema 校验）
 * 4. 根据决策生成交易指令
 *
 * 关键点：
 * - baseParamsSchema 声明 watchlist（必填），triggers() 返回 cron 触发器
 * - monitors 声明依赖的 monitor，TriggerManager 在 start() 时注入 reader
 * - monitorData('price') 返回 reader，readLatest(key) / readLast(key, n) 读取数据
 * - llm({ schema }) 返回类型由 Zod schema 推断，完全类型安全
 * - step() 缓存 LLM 调用结果，避免同一次 evaluate 内重复调用
 */

import { z } from 'zod'
import { BaseStrategy } from '../src/strategy/BaseStrategy.js'
import type { StrategyContext, StrategyOptions } from '../src/types/strategy.js'
import type { StrategyParams } from '../src/types/instance.js'
import type { ExecutionInstruction } from '../src/types/executor.js'
import type { Trigger } from '../src/types/trigger.js'

// ── LLM 输出 Schema ───────────────────────────────────────────────────────────

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

// ── Strategy 实现 ─────────────────────────────────────────────────────────────

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
      conditions: [{ type: 'cron', expression: '* * * * *' }],  // 每分钟
    }]
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const { watchlist } = this.params.base as { watchlist: string[] }

    // 收集所有交易对的市场数据
    const marketData = await this.step('market-data', () => this.collectMarketData(watchlist))
    if (Object.keys(marketData).length === 0) return []

    // 调用 LLM 分析，结果由 Zod schema 校验并推断类型
    const analysis = await this.step('llm-analysis', () =>
      this.llm({
        messages: [
          {
            role: 'system',
            content: [
              '你是一个专业的加密货币交易分析师。',
              '根据提供的市场数据，给出每个交易对的操作建议。',
              '只在高置信度（>0.7）时给出 buy/sell 建议，否则建议 hold。',
              '回答必须严格遵循 JSON schema，不要添加额外字段。',
            ].join('\n'),
          },
          {
            role: 'user',
            content: JSON.stringify({ timestamp: context.timestamp, marketData }),
          },
        ],
        schema: marketAnalysisSchema,
        // 可选：覆盖默认模型
        // model: 'anthropic:claude-3-5-haiku-20241022',
      })
    )

    // 只在高置信度时执行
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
    const baseAmount = analysis.confidence > 0.85 ? 200 : 100  // 高置信度加仓

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
