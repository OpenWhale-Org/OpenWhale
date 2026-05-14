import fs from 'fs'
import path from 'path'
import type { ExecutionInstruction, ExecutionQueue, ExecutionResult, ExecutorOptions, InstructionSchema, RetryOptions } from '../types/executor.js'
import type { AccountTypeDeclaration } from '../types/strategy.js'
import type { IAccount } from '../types/account.js'
import { getDataDir, getExecutionPath } from '../utils/paths.js'
import { createLogger } from '../utils/logger.js'

/**
 * @ai-guide How to write an Executor
 *
 * 1. Define the Instruction type:
 *    - Single action: define an interface extending ExecutionInstruction
 *    - Multiple actions: use a discriminated union keyed on the action field, each with its own params type
 *
 * 2. Implement executorName: return a unique string used to determine the JSONL execution record path
 *
 * 3. Implement supportedActions: return the list of action names this executor handles.
 *    run() automatically filters out instructions not in this list.
 *
 * 4. Implement execute(instruction): process a single instruction and return an ExecutionResult.
 *    - status: 'success' | 'failed' | 'skipped'
 *    - Throwing an exception will break the run() loop; prefer internal try/catch and return 'failed'
 *
 * 5. Optional: override instructionSchema with a Zod schema for runtime validation.
 *    On parse failure, the base class records a 'failed' result and skips execute().
 *    For multiple actions, use z.discriminatedUnion('action', [...]).
 *
 * Single action example (no Zod):
 * ```typescript
 * interface NotifyInstruction extends ExecutionInstruction {
 *   action: 'notify'
 *   params: { message: string; channel: string }
 * }
 *
 * class NotifyExecutor extends BaseExecutor<NotifyInstruction> {
 *   get executorName() { return 'notify' }
 *   get supportedActions() { return ['notify'] }
 *
 *   async execute(instruction: NotifyInstruction): Promise<ExecutionResult<NotifyInstruction>> {
 *     await sendMessage(instruction.params.channel, instruction.params.message)
 *     return { instruction, status: 'success', executedAt: new Date() }
 *   }
 * }
 * ```
 *
 * Multiple actions example (discriminated union):
 * ```typescript
 * type TradeInstruction =
 *   | { action: 'buy';  params: { symbol: string; amount: number } }
 *   | { action: 'sell'; params: { symbol: string; quantity: number } }
 *
 * class TradeExecutor extends BaseExecutor<TradeInstruction> {
 *   get executorName() { return 'trade' }
 *   get supportedActions() { return ['buy', 'sell'] }
 *
 *   async execute(instruction: TradeInstruction): Promise<ExecutionResult<TradeInstruction>> {
 *     if (instruction.action === 'buy') {
 *       // instruction.params is { symbol, amount } ✓
 *       await placeBuyOrder(instruction.params.symbol, instruction.params.amount)
 *     } else {
 *       // instruction.params is { symbol, quantity } ✓
 *       await placeSellOrder(instruction.params.symbol, instruction.params.quantity)
 *     }
 *     return { instruction, status: 'success', executedAt: new Date() }
 *   }
 * }
 * ```
 *
 * With Zod validation (multiple actions + discriminatedUnion):
 * ```typescript
 * const tradeSchema = z.discriminatedUnion('action', [
 *   z.object({ action: z.literal('buy'),  params: z.object({ symbol: z.string(), amount: z.number().positive() }) }),
 *   z.object({ action: z.literal('sell'), params: z.object({ symbol: z.string(), quantity: z.number().positive() }) }),
 * ])
 * type TradeInstruction = z.infer<typeof tradeSchema>
 *
 * class TradeExecutor extends BaseExecutor<TradeInstruction> {
 *   get executorName() { return 'trade' }
 *   get supportedActions() { return ['buy', 'sell'] }
 *   protected get instructionSchema() { return tradeSchema }
 *
 *   async execute(instruction: TradeInstruction): Promise<ExecutionResult<TradeInstruction>> {
 *     // instruction is fully validated by Zod here; types are safe
 *     if (instruction.action === 'buy') { ... }
 *     return { instruction, status: 'success', executedAt: new Date() }
 *   }
 * }
 * ```
 */
export abstract class BaseExecutor<TInstruction extends ExecutionInstruction = ExecutionInstruction> {
  protected readonly dataDir: string
  private readonly timeout: number
  private readonly retry: RetryOptions
  // TODO: Idempotency — needs a shared store (e.g. Redis SETNX) to work correctly in multi-instance deployments.
  // A process-local Set populated from JSONL on startup is insufficient: if instance A executes a message and
  // crashes before ACKing, instance B will reclaim and re-execute it without knowing A already succeeded.
  // For now, idempotency is not implemented. Executors should handle it in their own execute() logic.

  /** Per-instance account registry: instanceId → IAccount[] (in accountTypes order). */
  private readonly instanceAccounts = new Map<string, IAccount[]>()

  protected constructor(options?: Partial<ExecutorOptions>) {
    this.dataDir = getDataDir(options?.dataDir)
    this.timeout = options?.timeout ?? 0
    this.retry = options?.retry ?? { maxRetries: 0, retryDelay: 500, maxRetryDelay: 30000 }
  }

  private get log() { return createLogger(this.executorName) }

  abstract get executorName(): string
  abstract get supportedActions(): string[]
  abstract execute(instruction: TInstruction): Promise<ExecutionResult<TInstruction>>

  /**
   * Account type declarations for this executor.
   * Override in subclasses that require accounts (e.g. for signing orders).
   * Framework validates injected accounts against this list at execution time.
   */
  get accountTypes(): readonly AccountTypeDeclaration[] {
    return []
  }

  /**
   * Called by the framework when a strategy instance that uses this executor is activated.
   * Stores the resolved accounts keyed by instanceId for use during execute().
   */
  setAccounts(instanceId: string, accounts: IAccount[]): void {
    this.instanceAccounts.set(instanceId, accounts)
  }

  /**
   * Access an account injected for the current instruction's instance, by index or label.
   * Must be called from within execute() where this.currentInstruction is set.
   *
   * @example
   * const account = this.account<HyperliquidAccount>('trading')
   */
  protected account<T extends IAccount = IAccount>(indexOrLabel: number | string): T {
    const accounts = this.currentAccounts
    if (!accounts) throw new Error('No accounts available for this instruction — check accountTypes declaration and instruction.accountNames')
    if (typeof indexOrLabel === 'number') {
      const acc = accounts[indexOrLabel]
      if (!acc) throw new Error(`Executor account at index ${indexOrLabel} not found`)
      return acc as T
    }
    const idx = this.accountTypes.findIndex(
      (decl) => typeof decl === 'object' && decl.label === indexOrLabel
    )
    if (idx === -1) throw new Error(`Executor account with label '${indexOrLabel}' not declared in accountTypes`)
    const acc = accounts[idx]
    if (!acc) throw new Error(`Executor account with label '${indexOrLabel}' not found`)
    return acc as T
  }

  /** Set during runWithRetry so account() can access the right instance's accounts. */
  private currentAccounts: IAccount[] | undefined

  /**
   * Optional: provide a Zod schema to validate and narrow the instruction at runtime.
   * Supports z.discriminatedUnion('action', [...]) for multi-action executors.
   * If parse fails, the instruction is recorded as 'failed' and execute() is skipped.
   */
  protected get instructionSchema(): InstructionSchema<TInstruction> | undefined {
    return undefined
  }

  /**
   * Called when execute() throws after all retries are exhausted.
   * Override to add alerting, metrics, or custom fallback logic.
   */
  protected onError(_instruction: TInstruction, _error: unknown, _attempt: number): void {}

  async executeBatch(instructions: TInstruction[]): Promise<ExecutionResult<TInstruction>[]> {
    const results: ExecutionResult<TInstruction>[] = []
    for (const instruction of instructions) {
      results.push(await this.execute(instruction))
    }
    return results
  }

  async run(queue: ExecutionQueue, consumeId?: string): Promise<void> {
    // Queue routes by executorId — no need to filter supportedActions here,
    // but we still check as a safety net in case of misconfigured instructions.
    await queue.consume(consumeId ?? this.executorName, async (raw) => {
      if (!this.supportedActions.includes(raw.action)) return

      // Validate and resolve accounts if this executor declares accountTypes
      if (this.accountTypes.length > 0) {
        const accountError = this.validateAccounts(raw)
        if (accountError) {
          await this.recordSafe({ instruction: raw as TInstruction, status: 'failed', error: accountError, executedAt: new Date() })
          return
        }
      }

      // TODO: improve Record to track the full lifecycle (execution start -> execution end)
      const schema = this.instructionSchema
      if (schema) {
        const parsed = schema.safeParse(raw)
        if (!parsed.success) {
          await this.recordSafe({
            instruction: raw as TInstruction,
            status: 'failed',
            error: parsed.error.message,
            executedAt: new Date(),
          })
          return
        }
        await this.runWithRetry({ ...parsed.data, executorId: raw.executorId, messageId: raw.messageId, instanceId: raw.instanceId, accountNames: raw.accountNames } as TInstruction)
      } else {
        await this.runWithRetry(raw as TInstruction)
      }
    })
  }

  /**
   * Validates instruction.accountNames against this.accountTypes.
   * Returns an error string if invalid, undefined if valid.
   */
  private validateAccounts(raw: ExecutionInstruction): string | undefined {
    const { accountNames, instanceId } = raw
    const expected = this.accountTypes.length

    if (!accountNames || accountNames.length === 0)
      return `Executor "${this.executorName}" requires ${expected} account(s) but instruction carries none`

    if (accountNames.length !== expected)
      return `Executor "${this.executorName}" requires ${expected} account(s) but instruction carries ${accountNames.length}`

    // Verify each account exists and matches the declared type
    const accounts = instanceId ? this.instanceAccounts.get(instanceId) : undefined
    if (!accounts)
      return `No accounts injected for instance "${instanceId ?? '(unknown)'}" — was the instance activated?`

    for (let i = 0; i < this.accountTypes.length; i++) {
      const decl = this.accountTypes[i]!
      const expectedType = typeof decl === 'string' ? decl : decl.type
      const acc = accounts[i]
      if (!acc) return `Account[${i}] not found for instance "${instanceId}"`
      if (acc.accountType !== expectedType)
        return `Account[${i}] type mismatch: executor expects "${expectedType}" but got "${acc.accountType}" (name: "${acc.name}")`
    }

    return undefined
  }

  private async runWithRetry(instruction: TInstruction): Promise<void> {
    const { maxRetries, retryDelay, maxRetryDelay } = this.retry
    let lastError: unknown

    // Set currentAccounts so account() works inside execute()
    this.currentAccounts = instruction.instanceId
      ? this.instanceAccounts.get(instruction.instanceId)
      : undefined

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeWithTimeout(instruction)
        await this.recordSafe(result)
        this.currentAccounts = undefined
        return
      } catch (err) {
        lastError = err
        this.log.error({ action: instruction.action, messageId: instruction.messageId, attempt, err }, 'Execution error')
        this.onError(instruction, err, attempt)

        if (attempt < maxRetries) {
          const delay = Math.min(retryDelay * Math.pow(2, attempt), maxRetryDelay)
          this.log.warn({ action: instruction.action, attempt, delay }, 'Retrying after delay')
          await sleep(delay)
        }
      }
    }

    this.log.error({ action: instruction.action, messageId: instruction.messageId, maxRetries }, 'Instruction failed after all retries')
    await this.recordSafe({
      instruction,
      status: 'failed',
      error: lastError instanceof Error ? lastError.message : String(lastError),
      executedAt: new Date(),
    })
    this.currentAccounts = undefined
  }

  private async executeWithTimeout(instruction: TInstruction): Promise<ExecutionResult<TInstruction>> {
    if (this.timeout === 0) return this.execute(instruction)

    return Promise.race([
      this.execute(instruction),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Execution timed out after ${this.timeout}ms`)), this.timeout)
      ),
    ])
  }

  /** Silently swallows record errors to avoid crashing the consume loop on disk issues. */
  private async recordSafe(result: ExecutionResult<TInstruction>): Promise<void> {
    try {
      await this.record(result)
    } catch {
      // Disk full, permission error, etc. — log but don't crash the queue loop.
      this.log.error({ status: result.status, error: result.error }, 'Failed to record execution result')
    }
  }

  protected async record(result: ExecutionResult<TInstruction>): Promise<void> {
    const filePath = getExecutionPath(this.dataDir, this.executorName)
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.appendFile(filePath, JSON.stringify(result) + '\n', 'utf8')
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
