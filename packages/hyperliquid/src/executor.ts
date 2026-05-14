import { BaseExecutor, createLogger } from '@openwhale/core'
import type { ExecutionInstruction, ExecutionResult } from '@openwhale/core'
import { z } from 'zod'
import { HyperliquidAccount } from './account.js'

const log = createLogger('PerpTradingExecutor')

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
    slippage: z.number().min(0).max(1).optional(),
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
  constructor() {
    super()
  }

  get executorName(): string {
    return 'perp-trading'
  }

  get supportedActions(): string[] {
    return ['placeOrder', 'cancelOrder', 'setLeverage']
  }

  override get accountTypes() {
    return [{ type: 'hyperliquid', label: 'trading' }] as const
  }

  protected get instructionSchema() {
    return instructionSchema as any
  }

  private get adapter() {
    return this.account<HyperliquidAccount>('trading').getAdapter()
  }

  async execute(instruction: PerpInstruction & ExecutionInstruction): Promise<ExecutionResult<PerpInstruction & ExecutionInstruction>> {
    log.info({ action: instruction.action, messageId: instruction.messageId }, 'Executing instruction')

    try {
      switch (instruction.action) {
      case 'placeOrder': {
        const { symbol, side, type, amount, price, reduceOnly, timeInForce, slippage } = instruction.params
        log.debug({ symbol, side, type, amount, price, reduceOnly, timeInForce, slippage }, 'Placing order')

        const orderParams: Parameters<typeof this.adapter.createOrder>[0] = { symbol, side, type, amount }
        if (price !== undefined) orderParams.price = price
        if (reduceOnly !== undefined) orderParams.reduceOnly = reduceOnly
        if (timeInForce !== undefined) orderParams.timeInForce = timeInForce
        if (slippage !== undefined) orderParams.params = { slippage }

        const order = await this.adapter.createOrder(orderParams)
        log.info(
          { symbol, side, type, amount, orderId: order.id, status: order.status, filled: order.filled, price: order.price },
          'Order placed',
        )
        break
      }
      case 'cancelOrder': {
        const { orderId, symbol } = instruction.params
        log.debug({ orderId, symbol }, 'Cancelling order')
        await this.adapter.cancelOrder(orderId, symbol)
        log.info({ orderId, symbol }, 'Order cancelled')
        break
      }
      case 'setLeverage': {
        const { symbol, leverage, marginMode } = instruction.params
        log.debug({ symbol, leverage, marginMode }, 'Setting leverage')
        await this.adapter.setLeverage(symbol, leverage)
        if (marginMode) {
          await this.adapter.setMarginMode(symbol, marginMode)
          log.info({ symbol, leverage, marginMode }, 'Leverage and margin mode set')
        } else {
          log.info({ symbol, leverage }, 'Leverage set')
        }
        break
      }
    }

    log.info({ action: instruction.action, messageId: instruction.messageId }, 'Instruction completed')
    return { instruction, status: 'success', executedAt: new Date() }
    } catch (err) {
      log.error({ action: instruction.action, messageId: instruction.messageId, err }, 'Execution failed')
      throw err
    }
  }
}
