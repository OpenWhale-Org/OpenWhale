import { z } from 'zod'
import { BaseExecutor, OwExecutor } from '@openwhaleorg/core'
import type { ExecutionInstruction, ExecutionResult, ExecutorCredentialSlot, ExecutorOptions } from '@openwhaleorg/core'
import type { WalletCommand, WalletExecution, WalletExecutionOutcome, WhaleDanceWalletSession } from './types.js'

const coin = z.string().min(1).meta({ displayName: 'Asset', placeholder: 'BTC', description: 'WhaleDance / Hyperliquid asset name' })
const slippage = z.number().int().min(1).max(10_000).optional().meta({ displayName: 'Slippage (bps)' })

export const walletActionSchemas = {
  openMarket: z.object({
    coin,
    isBuy: z.boolean().meta({ displayName: 'Buy / Long' }),
    marginUsd: z.number().min(1).meta({ displayName: 'Margin (USD)' }),
    leverage: z.number().int().min(1).max(100),
    slippageBps: slippage,
  }),
  openLimit: z.object({
    coin,
    isBuy: z.boolean().meta({ displayName: 'Buy / Long' }),
    marginUsd: z.number().min(1).meta({ displayName: 'Margin (USD)' }),
    price: z.number().positive(),
    leverage: z.number().int().min(1).max(100),
  }),
  closePosition: z.object({ coin, size: z.number().positive(), slippageBps: slippage }),
  setLeverage: z.object({ coin, leverage: z.number().int().min(1).max(100), isCross: z.boolean().optional().default(false) }),
  adjustIsolatedMargin: z.object({ coin, deltaUsd: z.number().refine(v => v !== 0, 'deltaUsd cannot be zero') }),
  setTpSl: z.object({
    coin,
    size: z.number().positive(),
    tpPrice: z.number().positive().optional(),
    slPrice: z.number().positive().optional(),
  }).refine(v => v.tpPrice !== undefined || v.slPrice !== undefined, 'At least one of tpPrice or slPrice is required'),
  cancelOrders: z.object({
    cancels: z.array(z.object({ coin, orderId: z.number().int().positive() })).min(1).max(50),
  }),
  checkExecution: z.object({ executionId: z.string().min(1) }),
}

const instructionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('openMarket'), params: walletActionSchemas.openMarket }),
  z.object({ action: z.literal('openLimit'), params: walletActionSchemas.openLimit }),
  z.object({ action: z.literal('closePosition'), params: walletActionSchemas.closePosition }),
  z.object({ action: z.literal('setLeverage'), params: walletActionSchemas.setLeverage }),
  z.object({ action: z.literal('adjustIsolatedMargin'), params: walletActionSchemas.adjustIsolatedMargin }),
  z.object({ action: z.literal('setTpSl'), params: walletActionSchemas.setTpSl }),
  z.object({ action: z.literal('cancelOrders'), params: walletActionSchemas.cancelOrders }),
  z.object({ action: z.literal('checkExecution'), params: walletActionSchemas.checkExecution }),
])

type WalletInstruction = z.infer<typeof instructionSchema> & ExecutionInstruction

@OwExecutor({
  id: 'wallet-executor',
  name: 'WhaleDance Wallet',
  description: 'Policy-aware delegated Hyperliquid wallet execution through WhaleDance',
})
export class WhaleDanceWalletExecutor extends BaseExecutor<WalletInstruction> {
  constructor(options?: Partial<ExecutorOptions>) { super(options) }

  get executorName(): string { return 'wallet-executor' }

  get supportedActions(): string[] { return Object.keys(walletActionSchemas) }

  override get credentials(): readonly ExecutorCredentialSlot[] {
    return [{ label: 'wallet', kind: 'whaledance/wallet', type: 'whaledance/wallet' }]
  }

  override get actionSchemas() { return walletActionSchemas }

  protected override get instructionSchema() { return instructionSchema as never }

  async execute(instruction: WalletInstruction): Promise<ExecutionResult<WalletInstruction>> {
    const wallet = this.session<WhaleDanceWalletSession>('wallet')
    if (instruction.action === 'checkExecution') {
      const execution = await wallet.getExecution(instruction.params.executionId)
      return resultForExecution(instruction, execution)
    }

    const outcome = await wallet.execute(toCommand(instruction), instruction.messageId)
    return resultForOutcome(instruction, outcome)
  }
}

function toCommand(instruction: Exclude<WalletInstruction, { action: 'checkExecution' }>): WalletCommand {
  return { action: instruction.action, ...instruction.params } as WalletCommand
}

function resultForOutcome(instruction: WalletInstruction, outcome: WalletExecutionOutcome): ExecutionResult<WalletInstruction> {
  const data: Record<string, unknown> = {
    ...(outcome.executionId ? { executionId: outcome.executionId } : {}),
    remoteStatus: outcome.status,
    idempotencyKey: outcome.idempotencyKey,
    ...(outcome.replayed !== undefined ? { replayed: outcome.replayed } : {}),
    ...(outcome.result !== undefined ? { result: outcome.result } : {}),
  }
  return {
    instruction,
    status: localStatus(outcome.status),
    data,
    ...(outcome.error ? { error: outcome.error } : {}),
    executedAt: new Date(),
  }
}

function resultForExecution(instruction: WalletInstruction, execution: WalletExecution): ExecutionResult<WalletInstruction> {
  return {
    instruction,
    status: localStatus(execution.status),
    data: {
      executionId: execution.id,
      remoteStatus: execution.status,
      action: execution.action,
      ...(execution.asset ? { asset: execution.asset } : {}),
      ...(execution.result !== undefined ? { result: execution.result } : {}),
    },
    ...(execution.error !== undefined ? { error: typeof execution.error === 'string' ? execution.error : JSON.stringify(execution.error) } : {}),
    executedAt: new Date(),
  }
}

function localStatus(status: WalletExecution['status']): ExecutionResult['status'] {
  if (status === 'succeeded') return 'success'
  return status
}
