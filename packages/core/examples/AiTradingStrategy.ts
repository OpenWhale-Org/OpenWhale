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
 * - 构造函数传入 llm 配置，指定 defaultModel 和 provider
 * - CredentialStore 中需要存储对应的 API Key（如 'openai-api-key'）
 * - llm({ schema }) 返回类型由 Zod schema 推断，完全类型安全
 * - llm({ schema }) 内部使用 generateObject，无 schema 时使用 generateText
 * - parallel() 将多组指令合并为一个平铺数组
 * - step() 缓存 LLM 调用结果，避免同一次 evaluate 内重复调用
 */

import { z } from 'zod'
import { BaseStrategy } from '../src/strategy/BaseStrategy.js'
import type { StrategyContext } from '../src/types/strategy.js'
import type { ExecutionInstruction } from '../src/types/executor.js'

// ── LLM 输出 Schema ───────────────────────────────────────────────────────────

const marketAnalysisSchema = z.object({
  sentiment: z.enum(['bullish', 'bearish', 'neutral']),
  confidence: z.number().min(0).max(1),
  signals: z.array(z.object({
    symbol: z.string(),
    action: z.enum(['buy', 'sell', 'hold']),
    reason: z.string(),
    urgency: z.enum(['high', 'medium', 'low']),
  })),
  summary: z.string(),
})

type MarketAnalysis = z.infer<typeof marketAnalysisSchema>

// ── Strategy 实现 ─────────────────────────────────────────────────────────────

export class AiTradingStrategy extends BaseStrategy {
  readonly strategyId = 'ai-trading'

  private readonly watchlist: string[]

  constructor(watchlist: string[] = ['BTC', 'ETH', 'SOL']) {
    super({
      llm: {
        defaultModel: 'openai:gpt-4o-mini',
        // 如需自定义 credential 名称：
        // providers: [{ provider: 'openai', credentialName: 'my-openai-key' }]
      },
    })
    this.watchlist = watchlist
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    // 收集所有交易对的市场数据
    const marketData = await this.step('market-data', () => this.collectMarketData())

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
            content: JSON.stringify({
              timestamp: context.timestamp,
              marketData,
            }),
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

    if (signal.action === 'buy') {
      return [{
        executorId: 'trade',
        messageId: '',
        action: 'buy',
        params: { symbol: signal.symbol, quoteAmount: baseAmount },
      }]
    }

    if (signal.action === 'sell') {
      return [{
        executorId: 'trade',
        messageId: '',
        action: 'sell',
        params: { symbol: signal.symbol, baseAmount: 0.01 },
      }]
    }

    return []
  }

  private async collectMarketData(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {}

    for (const symbol of this.watchlist) {
      const reader = this.monitorData(symbol)
      if (!reader) continue

      const latest = await reader.readLatest()
      const history = await reader.readLast(10)

      if (latest) {
        result[symbol] = { latest, history }
      }
    }

    return result
  }
}
