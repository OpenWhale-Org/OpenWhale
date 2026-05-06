/**
 * Example: TradeExecutor
 *
 * 多 action Executor，处理 buy / sell / cancel 三种交易指令。
 *
 * 关键点：
 * - TInstruction 是 discriminated union，以 action 字段区分
 * - instructionSchema 使用 z.discriminatedUnion 做运行时校验
 *   parse 失败时基类自动记录 failed，不调用 execute()
 * - execute() 中通过 if/switch 收窄类型，params 类型完全安全
 * - onError() 覆盖用于告警（实际项目可接入 PagerDuty / Slack）
 * - 构造函数传入 retry 配置，网络抖动时自动重试
 */

import { z } from 'zod'
import { BaseExecutor } from '../src/executor/BaseExecutor.js'
import type { ExecutionResult } from '../src/types/executor.js'

// ── Instruction 类型定义 ──────────────────────────────────────────────────────

const buySchema = z.object({
  executorId: z.literal('trade'),
  messageId: z.string(),
  action: z.literal('buy'),
  params: z.object({
    symbol: z.string(),
    quoteAmount: z.number().positive(),  // 花多少 USDT
    slippagePct: z.number().min(0).max(100).default(0.5),
  }),
})

const sellSchema = z.object({
  executorId: z.literal('trade'),
  messageId: z.string(),
  action: z.literal('sell'),
  params: z.object({
    symbol: z.string(),
    baseAmount: z.number().positive(),   // 卖多少个币
    slippagePct: z.number().min(0).max(100).default(0.5),
  }),
})

const cancelSchema = z.object({
  executorId: z.literal('trade'),
  messageId: z.string(),
  action: z.literal('cancel'),
  params: z.object({
    orderId: z.string(),
  }),
})

const tradeSchema = z.discriminatedUnion('action', [buySchema, sellSchema, cancelSchema])

type TradeInstruction = z.infer<typeof tradeSchema>

// ── Executor 实现 ─────────────────────────────────────────────────────────────

export class TradeExecutor extends BaseExecutor<TradeInstruction> {
  get executorName() {
    return 'trade'
  }

  get supportedActions() {
    return ['buy', 'sell', 'cancel']
  }

  protected get instructionSchema() {
    return tradeSchema
  }

  constructor() {
    super({
      timeout: 10_000,
      retry: { maxRetries: 2, retryDelay: 1000, maxRetryDelay: 5000 },
    })
  }

  async execute(instruction: TradeInstruction): Promise<ExecutionResult<TradeInstruction>> {
    switch (instruction.action) {
      case 'buy': {
        const { symbol, quoteAmount, slippagePct } = instruction.params
        const orderId = await this.placeBuyOrder(symbol, quoteAmount, slippagePct)
        return {
          instruction,
          status: 'success',
          data: { orderId },
          executedAt: new Date(),
        }
      }

      case 'sell': {
        const { symbol, baseAmount, slippagePct } = instruction.params
        const orderId = await this.placeSellOrder(symbol, baseAmount, slippagePct)
        return {
          instruction,
          status: 'success',
          data: { orderId },
          executedAt: new Date(),
        }
      }

      case 'cancel': {
        await this.cancelOrder(instruction.params.orderId)
        return { instruction, status: 'success', executedAt: new Date() }
      }
    }
  }

  protected override onError(instruction: TradeInstruction, error: unknown, attempt: number): void {
    // 实际项目中接入告警系统
    console.error(`[TradeExecutor] attempt=${attempt} action=${instruction.action} error=${String(error)}`)
  }

  // ── 模拟交易所 API ────────────────────────────────────────────────────────

  private async placeBuyOrder(symbol: string, quoteAmount: number, _slippagePct: number): Promise<string> {
    // 替换为真实 API 调用
    console.log(`[TradeExecutor] BUY ${symbol} with ${quoteAmount} USDT`)
    return `order_${Date.now()}`
  }

  private async placeSellOrder(symbol: string, baseAmount: number, _slippagePct: number): Promise<string> {
    console.log(`[TradeExecutor] SELL ${baseAmount} ${symbol}`)
    return `order_${Date.now()}`
  }

  private async cancelOrder(orderId: string): Promise<void> {
    console.log(`[TradeExecutor] CANCEL ${orderId}`)
  }
}
