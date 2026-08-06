import { createHash } from 'crypto'
import { z } from 'zod'
import { BaseExecutor, OwExecutor, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, ExecutionResult, ExecutorOptions, ExecutorCredentialSlot } from '@openwhaleorg/core'
import type { PerpExchangeAdapter } from '../types/perp.js'

/**
 * Venue-agnostic perpetual trading executor — the write half of the
 * 'exchange/perp' kind. Registered by the exchange plugin as
 * 'exchange/perp-trading'; strategies reference that id and the session of
 * whichever credential the instance binds decides where orders land.
 *
 * Safety properties:
 * - clientOrderId is derived deterministically from the queue messageId, so a
 *   retried order that already reached the venue is rejected as a duplicate
 *   instead of filling twice. Caveat: most venues enforce client-id uniqueness
 *   against OPEN orders only — a market order that already filled can still be
 *   redelivered cross-process (see BaseExecutor's idempotency TODO).
 * - Amounts are rounded down to the market's lot precision before submission.
 */

/** Per-action params schemas — exposed via actionSchemas for introspection. */
const perpActionSchemas = {
  placeOrder: z.object({
    symbol: z.string().meta({ description: "Market symbol, e.g. 'BTC/USDC:USDC'" }),
    side: z.enum(['buy', 'sell']).meta({ description: 'buy = long / increase exposure, sell = short / reduce' }),
    type: z.enum(['market', 'limit']).meta({ description: 'market fills immediately; limit rests at `price`' }),
    amount: z.number().positive().meta({ description: 'Order size in base units (not USD notional)' }),
    price: z.number().positive().optional().meta({ description: 'Required for limit orders' }),
    reduceOnly: z.boolean().optional().meta({ description: 'Only reduce an existing position — never opens or flips' }),
    positionSide: z.enum(['long', 'short']).optional().meta({ description: "Hedge-mode (dual position side) accounts REQUIRE this: which position book the order acts on. buy+long / sell+short opens; sell+long / buy+short closes. Omit on one-way accounts." }),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO']).optional().meta({ description: 'GTC rests until filled; IOC/FOK cancel any unfilled part; PO is post-only (maker)' }),
    slippage: z.number().min(0).max(1).optional().meta({ description: 'Max slippage fraction for market orders (0.005 = 0.5%)' }),
  }),
  cancelOrder: z.object({
    orderId: z.string().meta({ description: 'Venue order id to cancel (see records / open orders)' }),
    symbol: z.string().meta({ description: 'Market symbol of the order' }),
  }),
  setLeverage: z.object({
    symbol: z.string().meta({ description: 'Market symbol to configure' }),
    leverage: z.number().int().positive().meta({ description: 'Leverage multiplier, e.g. 5' }),
    marginMode: z.enum(['cross', 'isolated']).optional().meta({ description: 'cross shares account margin; isolated dedicates margin per position' }),
  }),
}

const perpInstructionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('placeOrder'), params: perpActionSchemas.placeOrder }),
  z.object({ action: z.literal('cancelOrder'), params: perpActionSchemas.cancelOrder }),
  z.object({ action: z.literal('setLeverage'), params: perpActionSchemas.setLeverage }),
])

export type PerpInstruction = z.infer<typeof perpInstructionSchema> & ExecutionInstruction

/** Derive a 16-byte-hex client order id from the queue messageId. */
function toClientOrderId(messageId: string): string {
  return '0x' + createHash('sha256').update(messageId).digest('hex').slice(0, 32)
}

@OwExecutor({
  id: 'perp-trading',
  name: 'Perp Trading (any venue)',
  description: 'Venue-agnostic perpetual executor — trades through whichever exchange/perp account the instance binds',
})
export class PerpTradingExecutor extends BaseExecutor<PerpInstruction> {
  private get logger() { return createLogger(this.executorName) }

  constructor(options?: Partial<ExecutorOptions>) {
    super(options)
  }

  get executorName(): string {
    return 'perp-trading'
  }

  get supportedActions(): string[] {
    return ['placeOrder', 'cancelOrder', 'setLeverage']
  }

  override get credentials(): readonly ExecutorCredentialSlot[] {
    return [{ label: 'trading', kind: 'exchange/perp' }]
  }

  private get trading(): PerpExchangeAdapter {
    return this.session<PerpExchangeAdapter>('trading')
  }

  override get actionSchemas() {
    return perpActionSchemas
  }

  protected override get instructionSchema() {
    return perpInstructionSchema as never
  }

  async execute(instruction: PerpInstruction): Promise<ExecutionResult<PerpInstruction>> {
    this.logger.info({ action: instruction.action, messageId: instruction.messageId }, 'Executing instruction')

    try {
      let data: Record<string, unknown> | undefined

      switch (instruction.action) {
      case 'placeOrder': {
        const { symbol, side, type, amount, price, reduceOnly, positionSide, timeInForce, slippage } = instruction.params
        this.logger.debug({ symbol, side, type, amount, price, reduceOnly, positionSide, timeInForce, slippage }, 'Placing order')

        const trading = this.trading
        const venueAmount = await trading.baseAmountToContracts(symbol, amount)
        const preciseAmount = await trading.amountToPrecision(symbol, venueAmount)
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
        if (reduceOnly !== undefined) orderParams.reduceOnly = reduceOnly
        if (positionSide !== undefined) orderParams.positionSide = positionSide
        if (timeInForce !== undefined) orderParams.timeInForce = timeInForce
        if (slippage !== undefined) orderParams.params = { slippage }

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
      case 'setLeverage': {
        const { symbol, leverage, marginMode } = instruction.params
        const trading = this.trading
        await trading.setLeverage(symbol, leverage)
        if (marginMode) {
          // Some venues (Hyperliquid) require the leverage param here
          await trading.setMarginMode(symbol, marginMode, { leverage })
          this.logger.info({ symbol, leverage, marginMode }, 'Leverage and margin mode set')
        } else {
          this.logger.info({ symbol, leverage }, 'Leverage set')
        }
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
