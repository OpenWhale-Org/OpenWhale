export interface ExecutionInstruction {
  action: string
  params: Record<string, unknown>
}

export interface ExecutionResult {
  instruction: ExecutionInstruction
  status: 'success' | 'failed' | 'skipped'
  data?: Record<string, unknown>
  error?: string
  executedAt: Date
}

export interface ExecutionQueue {
  push(instruction: ExecutionInstruction): Promise<void>
  pushBatch(instructions: ExecutionInstruction[]): Promise<void>
  consume(handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void>
  stop(): Promise<void>
}

export interface ExecutorOptions {
  dataDir?: string
}
