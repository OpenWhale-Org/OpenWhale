import fs from 'fs'
import path from 'path'
import type { ExecutionInstruction, ExecutionQueue, ExecutionResult, ExecutorOptions } from '../types/executor.js'
import { getDataDir, getExecutionPath } from '../utils/paths.js'

export abstract class BaseExecutor {
  protected readonly dataDir: string

  constructor(options?: ExecutorOptions) {
    this.dataDir = getDataDir(options?.dataDir)
  }

  abstract get executorName(): string
  abstract get supportedActions(): string[]
  abstract execute(instruction: ExecutionInstruction): Promise<ExecutionResult>

  async executeBatch(instructions: ExecutionInstruction[]): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = []
    for (const instruction of instructions) {
      results.push(await this.execute(instruction))
    }
    return results
  }

  async run(queue: ExecutionQueue): Promise<void> {
    await queue.consume(async (instruction) => {
      if (!this.supportedActions.includes(instruction.action)) return
      const result = await this.execute(instruction)
      await this.record(result)
    })
  }

  protected async record(result: ExecutionResult): Promise<void> {
    const filePath = getExecutionPath(this.dataDir, this.executorName)
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.appendFile(filePath, JSON.stringify(result) + '\n', 'utf8')
  }
}
