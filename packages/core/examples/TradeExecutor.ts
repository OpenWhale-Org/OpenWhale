/**
 * Example: TradeExecutor
 *
 * Multi-action executor handling buy / sell / cancel trade instructions.
 *
 * Key points:
 * - TInstruction is a discriminated union keyed on the action field
 * - instructionSchema uses z.discriminatedUnion for runtime validation;
 *   on parse failure the base class records 'failed' and skips execute()
 * - execute() narrows types via if/switch; params types are fully safe
 * - onError() is overridden for alerting (in production, hook into PagerDuty / Slack)
 * - Constructor passes retry config for automatic retries on transient network errors
 */

import { z } from 'zod'
import { BaseExecutor } from '../src/executor/BaseExecutor.js'
import type { ExecutionResult } from '../src/types/executor.js'

// ── Instruction type definitions ──────────────────────────────────────────────

const buySchema = z.object({
  executorId: z.literal('trade'),
  messageId: z.string(),
  action: z.literal('buy'),
  params: z.object({
    symbol: z.string(),
    quoteAmount: z.number().positive(),  // how much USDT to spend
    slippagePct: z.number().min(0).max(100).default(0.5),
  }),
})

const sellSchema = z.object({
  executorId: z.literal('trade'),
  messageId: z.string(),
  action: z.literal('sell'),
  params: z.object({
    symbol: z.string(),
    baseAmount: z.number().positive(),   // how many tokens to sell
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

// ── Executor implementation ───────────────────────────────────────────────────

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
    // hook into an alerting system in production
    console.error(`[TradeExecutor] attempt=${attempt} action=${instruction.action} error=${String(error)}`)
  }

  // ── Simulated exchange API ────────────────────────────────────────────────

  private async placeBuyOrder(symbol: string, quoteAmount: number, _slippagePct: number): Promise<string> {
    // replace with real API call
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
