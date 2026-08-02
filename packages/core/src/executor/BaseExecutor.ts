import fs from 'fs'
import path from 'path'
import { AsyncLocalStorage } from 'async_hooks'
import type { ExecutionInstruction, ExecutionQueue, ExecutionResult, ExecutorOptions, InstructionSchema, RetryOptions } from '../types/executor.js'
import type { ZodObject, ZodRawShape } from 'zod'
import { isTerminalError } from '../types/adapter/errors.js'
import type { ExecutorCredentialSlot } from '../types/materialization.js'
import type { RawCredentialData } from '../types/credential.js'
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
 * 4. Declare credential slots (override `credentials`) when the executor needs venue access:
 *      get credentials() { return [{ label: 'trading', kind: 'exchange/perp' }] }        // → session
 *      get credentials() { return [{ label: 'bot', type: 'telegram', raw: true }] }      // → raw data
 *    The framework materializes bound credentials at activation; inside execute() use
 *    this.session<T>('trading') / this.raw('bot').
 *
 * 5. Implement execute(instruction): process a single instruction and return an ExecutionResult.
 *    - status: 'success' | 'failed' | 'skipped'
 *    - Throwing an exception triggers the retry policy; prefer internal try/catch and
 *      return 'failed' for domain-level failures that should not retry
 *
 * 6. Optional: override instructionSchema with a Zod schema for runtime validation.
 *    On parse failure, the base class records a 'failed' result and skips execute().
 *    For multiple actions, use z.discriminatedUnion('action', [...]).
 */
export abstract class BaseExecutor<TInstruction extends ExecutionInstruction = ExecutionInstruction> {
  protected readonly dataDir: string
  private readonly timeout: number
  private readonly retry: RetryOptions
  private readonly maxConcurrent: number
  // TODO: Idempotency — needs a shared store (e.g. Redis SETNX) to work correctly in multi-instance deployments.
  // A process-local Set populated from JSONL on startup is insufficient: if instance A executes a message and
  // crashes before ACKing, instance B will reclaim and re-execute it without knowing A already succeeded.
  // For now, idempotency is not implemented. Executors should handle it in their own execute() logic.

  /** Per-instance materialized credential slots (instanceId → label → materialization). */
  private readonly instanceSlots = new Map<string, Map<string, MaterializedSlot>>()
  /** Per-instance sessions addressable by credential name (accountNames routing). */
  private readonly instanceSessions = new Map<string, Map<string, unknown>>()

  protected constructor(options?: Partial<ExecutorOptions>) {
    this.dataDir = getDataDir(options?.dataDir)
    this.timeout = options?.timeout ?? 0
    this.retry = options?.retry ?? { maxRetries: 0, retryDelay: 500, maxRetryDelay: 30000 }
    this.maxConcurrent = Math.max(1, options?.maxConcurrent ?? 1)
  }

  private get log() { return createLogger(this.executorName) }

  abstract get executorName(): string
  abstract get supportedActions(): string[]
  abstract execute(instruction: TInstruction): Promise<ExecutionResult<TInstruction>>

  /**
   * Credential slots this executor needs. Override in subclasses that touch
   * venues or external services. Sessions are write-capable venue connections;
   * raw slots receive decrypted credential data (explicit opt-in).
   */
  get credentials(): readonly ExecutorCredentialSlot[] {
    return []
  }

  /**
   * Called by the framework at activation with the instance's materialized
   * credential slots.
   */
  setMaterialized(instanceId: string, slots: readonly MaterializedSlot[]): void {
    this.instanceSlots.set(instanceId, new Map(slots.map(s => [s.label, s])))
    this.instanceSessions.set(instanceId, new Map(
      slots.filter(s => s.session !== undefined).map(s => [s.credentialName, s.session])
    ))
  }

  /** Called by the framework when a strategy instance is deactivated. */
  removeMaterialized(instanceId: string): void {
    this.instanceSlots.delete(instanceId)
    this.instanceSessions.delete(instanceId)
  }

  /**
   * The session bound to a declared slot, for the current instruction.
   * If the instruction carries accountNames, the name at this slot's position
   * (among session slots) overrides the instance-level binding — this is how
   * a strategy routes between several bound credentials per instruction.
   */
  protected session<T = unknown>(label: string): T {
    const ctx = this.executionContext.getStore()
    if (!ctx) throw new Error('session() called outside execute()')
    const slot = ctx.slots.get(label)
    if (!slot) throw new Error(`Executor "${this.executorName}": credential slot '${label}' is not declared/bound`)
    if (slot.session === undefined) throw new Error(`Executor "${this.executorName}": slot '${label}' is a raw slot, not a session`)

    const sessionSlotLabels = this.credentials.filter(c => !('raw' in c)).map(c => c.label)
    const idx = sessionSlotLabels.indexOf(label)
    const override = idx !== -1 ? ctx.instruction.accountNames?.[idx] : undefined
    if (override && override !== slot.credentialName) {
      const byName = ctx.sessions.get(override)
      if (byName === undefined) {
        throw new Error(`Executor "${this.executorName}": instruction routed slot '${label}' to credential "${override}" which is not bound to this instance`)
      }
      return byName as T
    }
    return slot.session as T
  }

  /** Decrypted credential data of a raw slot, for the current instruction. */
  protected raw(label: string): RawCredentialData {
    const ctx = this.executionContext.getStore()
    if (!ctx) throw new Error('raw() called outside execute()')
    const slot = ctx.slots.get(label)
    if (!slot) throw new Error(`Executor "${this.executorName}": credential slot '${label}' is not declared/bound`)
    if (slot.raw === undefined) throw new Error(`Executor "${this.executorName}": slot '${label}' is a session slot, not raw`)
    return slot.raw
  }

  /**
   * Per-execution context. AsyncLocalStorage (rather than a mutable field)
   * so concurrent or timed-out-but-still-running execute() calls can never
   * observe another instruction's credentials.
   */
  private readonly executionContext = new AsyncLocalStorage<ExecutionCredentialContext>()

  /**
   * Optional: provide a Zod schema to validate and narrow the instruction at runtime.
   * Supports z.discriminatedUnion('action', [...]) for multi-action executors.
   * If parse fails, the instruction is recorded as 'failed' and execute() is skipped.
   */
  protected get instructionSchema(): InstructionSchema<TInstruction> | undefined {
    return undefined
  }

  /**
   * Machine-readable per-action PARAMS schemas — the executor's self-description.
   * Keyed by action name; each value validates `instruction.params` for that action.
   *
   * One declaration serves four consumers: the AI compiler's prompt (what
   * instructions may be emitted), its dry-run validation of generated
   * strategies, runtime enforcement (params are parsed before execute() when
   * instructionSchema is not overridden), and dashboard display.
   */
  get actionSchemas(): Record<string, ZodObject<ZodRawShape>> | undefined {
    return undefined
  }

  /**
   * Called when execute() throws after all retries are exhausted.
   * Override to add alerting, metrics, or custom fallback logic.
   */
  protected onError(_instruction: TInstruction, _error: unknown, _attempt: number): void {}

  async run(queue: ExecutionQueue, consumeId?: string): Promise<void> {
    const id = consumeId ?? this.executorName
    if (this.maxConcurrent === 1) {
      // Strictly serial — the default contract all executors may rely on.
      await queue.consume(id, async (raw) => { await this.handleRaw(raw) })
      return
    }

    // Opt-in concurrency: the consume loop returns as soon as a slot is free,
    // so up to maxConcurrent instructions overlap. handleRaw never throws.
    const inFlight = new Set<Promise<void>>()
    await queue.consume(id, async (raw) => {
      while (inFlight.size >= this.maxConcurrent) await Promise.race(inFlight)
      const task = this.handleRaw(raw).then(() => undefined).finally(() => inFlight.delete(task))
      inFlight.add(task)
    })
    // Queue stopped — drain what is still running before returning.
    await Promise.all(inFlight)
  }

  /**
   * Execute one instruction OUTSIDE the queue — the dashboard's manual fire.
   * Same validation, retry, and recording path as queued instructions.
   * Credential slots must be materialized for the instruction's instanceId first.
   */
  async fire(raw: ExecutionInstruction): Promise<ExecutionResult<TInstruction> | undefined> {
    return this.handleRaw(raw)
  }

  /** Full handling of one dequeued instruction: filters, validation, retry loop, recording. */
  private async handleRaw(raw: ExecutionInstruction): Promise<ExecutionResult<TInstruction> | undefined> {
    {
      // Queue routes by executorId — no need to filter supportedActions here,
      // but we still check as a safety net in case of misconfigured instructions.
      if (!this.supportedActions.includes(raw.action)) return undefined

      if (this.credentials.length > 0) {
        const credentialError = this.validateCredentials(raw)
        if (credentialError) {
          const result: ExecutionResult<TInstruction> = { instruction: raw as TInstruction, status: 'failed', error: credentialError, executedAt: new Date() }
          await this.recordSafe(result)
          return result
        }
      }

      // Declarative per-action params validation (skipped when the executor
      // overrides instructionSchema — that path already narrows params).
      if (!this.instructionSchema) {
        const paramsSchema = this.actionSchemas?.[raw.action]
        if (paramsSchema) {
          const parsedParams = paramsSchema.safeParse(raw.params)
          if (!parsedParams.success) {
            const result: ExecutionResult<TInstruction> = {
              instruction: raw as TInstruction,
              status: 'failed',
              error: `Invalid params for action "${raw.action}": ${parsedParams.error.message}`,
              executedAt: new Date(),
            }
            await this.recordSafe(result)
            return result
          }
        }
      }

      // TODO: improve Record to track the full lifecycle (execution start -> execution end)
      const schema = this.instructionSchema
      if (schema) {
        const parsed = schema.safeParse(raw)
        if (!parsed.success) {
          const result: ExecutionResult<TInstruction> = {
            instruction: raw as TInstruction,
            status: 'failed',
            error: parsed.error.message,
            executedAt: new Date(),
          }
          await this.recordSafe(result)
          return result
        }
        return await this.runWithRetry({ ...parsed.data, executorId: raw.executorId, messageId: raw.messageId, instanceId: raw.instanceId, accountNames: raw.accountNames } as TInstruction)
      } else {
        return await this.runWithRetry(raw as TInstruction)
      }
    }
  }

  /** Validates the instruction against this executor's bound credential slots. */
  private validateCredentials(raw: ExecutionInstruction): string | undefined {
    const { accountNames, instanceId } = raw

    const slots = instanceId ? this.instanceSlots.get(instanceId) : undefined
    if (!slots)
      return `No credentials materialized for instance "${instanceId ?? '(unknown)'}" — was the instance activated?`

    for (const decl of this.credentials) {
      if (!slots.has(decl.label))
        return `Credential slot '${decl.label}' of executor "${this.executorName}" is not bound for instance "${instanceId}"`
    }

    // Optional per-instruction routing: names must reference bound sessions
    if (accountNames && accountNames.length > 0) {
      const sessions = this.instanceSessions.get(instanceId!)
      for (const name of accountNames) {
        if (!sessions?.has(name))
          return `Instruction routes to credential "${name}" which is not bound to instance "${instanceId}"`
      }
    }

    return undefined
  }

  private async runWithRetry(instruction: TInstruction): Promise<ExecutionResult<TInstruction>> {
    const { maxRetries, retryDelay, maxRetryDelay } = this.retry
    let lastError: unknown

    const instanceId = instruction.instanceId ?? ''
    const context: ExecutionCredentialContext = {
      slots: this.instanceSlots.get(instanceId) ?? new Map(),
      sessions: this.instanceSessions.get(instanceId) ?? new Map(),
      instruction,
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executionContext.run(context, () => this.executeWithTimeout(instruction))
        await this.recordSafe(result)
        return result
      } catch (err) {
        lastError = err
        this.log.error({ action: instruction.action, messageId: instruction.messageId, attempt, err }, 'Execution error')
        this.onError(instruction, err, attempt)

        // A timeout means execute() may still be running and may have taken effect
        // (e.g. an order placed but the response lost). Retrying would risk executing
        // twice, so timeouts are terminal. Executors that can retry safely must make
        // execute() idempotent (e.g. clientOrderId) and catch timeouts internally.
        if (err instanceof ExecutionTimeoutError) break

        // Adapter-declared terminal errors (bad params, insufficient funds, auth)
        // cannot succeed on retry — fail fast.
        if (isTerminalError(err)) break

        if (attempt < maxRetries) {
          const delay = Math.min(retryDelay * Math.pow(2, attempt), maxRetryDelay)
          this.log.warn({ action: instruction.action, attempt, delay }, 'Retrying after delay')
          await sleep(delay)
        }
      }
    }

    this.log.error({ action: instruction.action, messageId: instruction.messageId, maxRetries }, 'Instruction failed after all retries')
    const failure: ExecutionResult<TInstruction> = {
      instruction,
      status: 'failed',
      error: lastError instanceof Error ? lastError.message : String(lastError),
      executedAt: new Date(),
    }
    await this.recordSafe(failure)
    return failure
  }

  private async executeWithTimeout(instruction: TInstruction): Promise<ExecutionResult<TInstruction>> {
    if (this.timeout === 0) return this.execute(instruction)

    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([
        this.execute(instruction),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ExecutionTimeoutError(this.timeout)), this.timeout)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
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

/** A credential slot materialized for one instance. Exactly one of session/raw is set. */
export interface MaterializedSlot {
  label: string
  credentialName: string
  session?: unknown
  raw?: RawCredentialData
}

interface ExecutionCredentialContext {
  slots: Map<string, MaterializedSlot>
  sessions: Map<string, unknown>
  instruction: ExecutionInstruction
}

export class ExecutionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`)
    this.name = 'ExecutionTimeoutError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
