import type { ZodType } from 'zod'
import type { ExecutorCredentialSlot } from './materialization.js'

export interface ExecutionInstruction {
  executorId: string
  /** Unique message ID for idempotency checks. Populated by the queue implementation. */
  messageId: string
  action: string
  params: Record<string, unknown>
  /** Strategy instance that emitted this instruction. Injected by TriggerManager. */
  instanceId?: string
  /**
   * Credential names of accounts to use for this instruction, in the order declared by
   * the executor's accountTypes. Validated against accountTypes at execution time.
   */
  accountNames?: string[]
}

export interface IExecutor {
  readonly executorName: string
  readonly supportedActions: string[]
  /** Credential slots this executor needs. Framework materializes them at activate() time. */
  readonly credentials: readonly ExecutorCredentialSlot[]
  setMaterialized(instanceId: string, slots: readonly { label: string; credentialName: string; session?: unknown; raw?: Record<string, unknown> }[]): void
  removeMaterialized(instanceId: string): void
}

export interface ExecutionResult<TInstruction extends ExecutionInstruction = ExecutionInstruction> {
  instruction: TInstruction
  status: 'success' | 'failed' | 'skipped'
  data?: Record<string, unknown>
  error?: string
  executedAt: Date
}

export interface ExecutionQueue {
  push(instruction: ExecutionInstruction): Promise<void>
  pushBatch(instructions: ExecutionInstruction[]): Promise<void>
  /** Consume instructions for a specific executorId. Blocks until stop() is called. */
  consume(executorId: string, handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void>
  /**
   * Detach all current consumers of an executorId without stopping the queue —
   * the hot plugin-replace path (a new executor object takes over the id).
   * Queued instructions remain for the next consumer.
   */
  cancelConsumers?(executorId: string): void
  stop(): Promise<void>
}

export interface RetryOptions {
  /** Maximum number of retry attempts after the first failure. Default: 0 (no retry). */
  maxRetries: number
  /** Base delay in ms between retries. Actual delay = retryDelay * 2^attempt (exponential backoff). Default: 500. */
  retryDelay: number
  /** Maximum delay cap in ms to prevent unbounded backoff. Default: 30000. */
  maxRetryDelay: number
}

export interface ExecutorOptions {
  dataDir?: string
  /** Timeout in ms for a single execute() call. 0 = no timeout. Default: 0. */
  timeout: number
  retry: RetryOptions
  /**
   * Maximum instructions this executor processes concurrently. Default 1 —
   * strictly serial, the semantics every executor's idempotency/dedup logic
   * may assume. Opt in (>1) only when execute() is safe to overlap with
   * itself, e.g. long-lived timed executions for independent instances.
   */
  maxConcurrent?: number
}

export type InstructionSchema<TInstruction extends ExecutionInstruction> = ZodType<TInstruction>
