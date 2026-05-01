import fs from 'fs'
import path from 'path'
import type { ExecutionInstruction, ExecutionQueue, ExecutionResult, ExecutorOptions, InstructionSchema, RetryOptions } from '../types/executor.js'
import { getDataDir, getExecutionPath } from '../utils/paths.js'
import { createLogger } from '../utils/logger.js'

/**
 * @ai-guide 如何编写一个 Executor
 *
 * 1. 定义 Instruction 类型：
 *    - 单 action：直接定义一个 interface 继承 ExecutionInstruction
 *    - 多 action：用 discriminated union，以 action 字段区分，每种 action 有独立的 params 类型
 *
 * 2. 实现 executorName：返回唯一字符串，用于确定执行记录的 JSONL 文件路径
 *
 * 3. 实现 supportedActions：返回该 Executor 处理的 action 名称列表，
 *    run() 会自动过滤掉不在列表中的指令
 *
 * 4. 实现 execute(instruction)：处理单条指令，返回 ExecutionResult
 *    - status: 'success' | 'failed' | 'skipped'
 *    - 抛出异常会导致 run() 循环中断，建议内部 try/catch 并返回 failed
 *
 * 5. 可选：覆盖 instructionSchema，提供 Zod schema 做运行时校验，
 *    parse 失败时自动记录 failed 结果，不调用 execute()
 *    多 action 时推荐使用 z.discriminatedUnion('action', [...])
 *
 * 单 action 示例（无 Zod）：
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
 * 多 action 示例（discriminated union）：
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
 *       // instruction.params 是 { symbol, amount } ✓
 *       await placeBuyOrder(instruction.params.symbol, instruction.params.amount)
 *     } else {
 *       // instruction.params 是 { symbol, quantity } ✓
 *       await placeSellOrder(instruction.params.symbol, instruction.params.quantity)
 *     }
 *     return { instruction, status: 'success', executedAt: new Date() }
 *   }
 * }
 * ```
 *
 * 带 Zod 校验示例（多 action + discriminatedUnion）：
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
 *     // 到这里 instruction 已经过 Zod 校验，类型完全安全
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

  async run(queue: ExecutionQueue): Promise<void> {
    // Queue routes by executorId — no need to filter supportedActions here,
    // but we still check as a safety net in case of misconfigured instructions.
    await queue.consume(this.executorName, async (raw) => {
      if (!this.supportedActions.includes(raw.action)) return

      // TODO: 优化 Record，需要跟踪全流程（开始执行 -> 执行结束）

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
        await this.runWithRetry(parsed.data)
      } else {
        await this.runWithRetry(raw as TInstruction)
      }
    })
  }

  private async runWithRetry(instruction: TInstruction): Promise<void> {
    const { maxRetries, retryDelay, maxRetryDelay } = this.retry
    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.executeWithTimeout(instruction)
        await this.recordSafe(result)
        return
      } catch (err) {
        lastError = err
        this.onError(instruction, err, attempt)

        if (attempt < maxRetries) {
          const delay = Math.min(retryDelay * Math.pow(2, attempt), maxRetryDelay)
          await sleep(delay)
        }
      }
    }

    await this.recordSafe({
      instruction,
      status: 'failed',
      error: lastError instanceof Error ? lastError.message : String(lastError),
      executedAt: new Date(),
    })
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
