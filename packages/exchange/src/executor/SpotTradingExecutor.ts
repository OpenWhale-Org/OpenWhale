import { createHash } from 'crypto'
import { z } from 'zod'
import { BaseExecutor, OwExecutor, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, ExecutionResult, ExecutorOptions, ExecutorCredentialSlot } from '@openwhaleorg/core'
import type { SpotExchangeAdapter } from '../types/spot.js'

/**
 * Venue-agnostic spot trading executor — the write half of the
 * 'exchange/spot' kind. Registered by the exchange plugin as
 * 'exchange/spot-trading'; strategies reference that id and the session of
 * whichever credential the instance binds decides where orders land.
 *
 * Mirrors PerpTradingExecutor minus everything perp-specific: no leverage,
 * no positionSide, no reduceOnly — a spot order either spends quote to buy
 * base or sells base for quote, and that is the whole story.
 *
 * Safety properties shared with the perp executor:
 * - clientOrderId derives deterministically from the queue messageId, so a
 *   retried order that already reached the venue is rejected as a duplicate
 *   instead of filling twice.
 * - Amounts round down to the market's lot precision before submission.
 */

const spotActionSchemas = {
  placeOrder: z.object({
    symbol: z.string().meta({ description: "Spot market symbol, e.g. 'BTC/USDT'" }),
    side: z.enum(['buy', 'sell']),
    type: z.enum(['market', 'limit']),
    amount: z.number().positive().meta({ description: 'Order size in base units (not USD notional)' }),
    price: z.number().positive().optional().meta({ description: 'Required for limit orders' }),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO']).optional(),
  }),
  cancelOrder: z.object({
    orderId: z.string(),
    symbol: z.string(),
  }),
}

const spotInstructionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('placeOrder'), params: spotActionSchemas.placeOrder }),
  z.object({ action: z.literal('cancelOrder'), params: spotActionSchemas.cancelOrder }),
])

export type SpotInstruction = z.infer<typeof spotInstructionSchema> & ExecutionInstruction

/** Derive a 16-byte-hex client order id from the queue messageId. */
function toClientOrderId(messageId: string): string {
  return '0x' + createHash('sha256').update(messageId).digest('hex').slice(0, 32)
}

@OwExecutor({
  id: 'spot-trading',
  name: 'Spot Trading (any venue)',
  description: 'Venue-agnostic spot executor — buys/sells through whichever exchange/spot account the instance binds. No leverage, no positions: holdings are the balances.',
})
export class SpotTradingExecutor extends BaseExecutor<SpotInstruction> {
  private get logger() { return createLogger(this.executorName) }

  constructor(options?: Partial<ExecutorOptions>) {
    super(options)
  }

  get executorName(): string {
    return 'spot-trading'
  }

  get supportedActions(): string[] {
    return ['placeOrder', 'cancelOrder']
  }

  override get credentials(): readonly ExecutorCredentialSlot[] {
    return [{ label: 'trading', kind: 'exchange/spot' }]
  }

  private get trading(): SpotExchangeAdapter {
    return this.session<SpotExchangeAdapter>('trading')
  }

  override get actionSchemas() {
    return spotActionSchemas
  }

  protected override get instructionSchema() {
    return spotInstructionSchema as never
  }

  async execute(instruction: SpotInstruction): Promise<ExecutionResult<SpotInstruction>> {
    this.logger.info({ action: instruction.action, messageId: instruction.messageId }, 'Executing instruction')

    try {
      let data: Record<string, unknown> | undefined

      switch (instruction.action) {
      case 'placeOrder': {
        const { symbol, side, type, amount, price, timeInForce } = instruction.params

        const trading = this.trading
        const preciseAmount = await trading.amountToPrecision(symbol, amount)
        if (preciseAmount <= 0) {
          this.logger.info({ symbol, amount, preciseAmount }, 'Amount rounds to zero at market precision — skipping')
          return { instruction, status: 'skipped', executedAt: new Date() }
        }

        const orderParams: Parameters<typeof trading.createOrder>[0] = {
          symbol, side, type,
          amount: preciseAmount,
          clientOrderId: toClientOrderId(instruction.messageId),
        }
        if (price !== undefined) orderParams.price = price
        if (timeInForce !== undefined) orderParams.params = { timeInForce }

        const order = await trading.createOrder(orderParams)
        this.logger.info(
          { symbol, side, type, amount: preciseAmount, orderId: order.id, status: order.status, filled: order.filled, average: order.average },
          'Order placed',
        )
        data = { orderId: order.id, status: order.status, filled: order.filled, average: order.average }
        break
      }
      case 'cancelOrder': {
        const { orderId, symbol } = instruction.params
        await this.trading.cancelOrder(orderId, symbol)
        this.logger.info({ orderId, symbol }, 'Order cancelled')
        break
      }
      }

      return { instruction, status: 'success', ...(data ? { data } : {}), executedAt: new Date() }
    } catch (err) {
      this.logger.error({ action: instruction.action, messageId: instruction.messageId, err }, 'Execution failed')
      throw err
    }
  }
}
