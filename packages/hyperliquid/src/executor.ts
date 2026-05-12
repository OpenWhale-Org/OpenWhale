import { BaseExecutor } from '@openwhale/core'
import type { ExecutionInstruction, ExecutionResult } from '@openwhale/core'
import { z } from 'zod'
import type { HyperliquidAdapter } from './adapter.js'

// ── Instruction types ─────────────────────────────────────────────────────────

const placeOrderSchema = z.object({
  action: z.literal('placeOrder'),
  params: z.object({
    symbol: z.string(),
    side: z.enum(['buy', 'sell']),
    type: z.enum(['market', 'limit']),
    amount: z.number().positive(),
    price: z.number().positive().optional(),
    reduceOnly: z.boolean().optional(),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO']).optional(),
  }),
})

const cancelOrderSchema = z.object({
  action: z.literal('cancelOrder'),
  params: z.object({
    orderId: z.string(),
    symbol: z.string(),
  }),
})

const setLeverageSchema = z.object({
  action: z.literal('setLeverage'),
  params: z.object({
    symbol: z.string(),
    leverage: z.number().int().positive(),
    marginMode: z.enum(['cross', 'isolated']).optional(),
  }),
})

const instructionSchema = z.discriminatedUnion('action', [
  placeOrderSchema,
  cancelOrderSchema,
  setLeverageSchema,
])

type PerpInstruction = z.infer<typeof instructionSchema>

// ── Executor ──────────────────────────────────────────────────────────────────

export class PerpTradingExecutor extends BaseExecutor<PerpInstruction & ExecutionInstruction> {
  constructor(private readonly adapter: HyperliquidAdapter) {
    super()
  }

  get executorName(): string {
    return 'perp-trading'
  }

  get supportedActions(): string[] {
    return ['placeOrder', 'cancelOrder', 'setLeverage']
  }

  protected get instructionSchema() {
    return instructionSchema as any
  }

  async execute(instruction: PerpInstruction & ExecutionInstruction): Promise<ExecutionResult<PerpInstruction & ExecutionInstruction>> {
    switch (instruction.action) {
      case 'placeOrder': {
        const { symbol, side, type, amount, price, reduceOnly, timeInForce } = instruction.params
        const orderParams: Parameters<typeof this.adapter.createOrder>[0] = { symbol, side, type, amount }
        if (price !== undefined) orderParams.price = price
        if (reduceOnly !== undefined) orderParams.reduceOnly = reduceOnly
        if (timeInForce !== undefined) orderParams.timeInForce = timeInForce
        await this.adapter.createOrder(orderParams)
        break
      }
      case 'cancelOrder': {
        const { orderId, symbol } = instruction.params
        await this.adapter.cancelOrder(orderId, symbol)
        break
      }
      case 'setLeverage': {
        const { symbol, leverage, marginMode } = instruction.params
        await this.adapter.setLeverage(symbol, leverage)
        if (marginMode) await this.adapter.setMarginMode(symbol, marginMode)
        break
      }
    }
    return { instruction, status: 'success', executedAt: new Date() }
  }
}
