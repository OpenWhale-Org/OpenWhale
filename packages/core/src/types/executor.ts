import type { ZodType } from 'zod'

export interface ExecutionInstruction {
  executorId: string
  /** Unique message ID for idempotency checks. Populated by the queue implementation. */
  messageId: string
  action: string
  params: Record<string, unknown>
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
   * Idempotency mode. Default: true.
   * When true, instructions with a messageId that was already successfully
   * executed (per today's JSONL execution record) are skipped without calling execute().
   */
  idempotent: boolean
}

export type InstructionSchema<TInstruction extends ExecutionInstruction> = ZodType<TInstruction>
