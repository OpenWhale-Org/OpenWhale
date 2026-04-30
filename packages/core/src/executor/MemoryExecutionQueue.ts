import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'

export class MemoryExecutionQueue implements ExecutionQueue {
  private readonly queue: ExecutionInstruction[] = []
  private readonly waiters: Array<(instruction: ExecutionInstruction) => void> = []
  private stopped = false

  async push(instruction: ExecutionInstruction): Promise<void> {
    if (this.stopped) return
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter(instruction)
    } else {
      this.queue.push(instruction)
    }
  }

  async pushBatch(instructions: ExecutionInstruction[]): Promise<void> {
    for (const instruction of instructions) {
      await this.push(instruction)
    }
  }

  async consume(handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void> {
    while (!this.stopped) {
      const instruction = await this.dequeue()
      if (instruction === null) break
      await handler(instruction)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const waiter of this.waiters.splice(0)) {
      waiter({ action: '__stop__', params: {} })
    }
  }

  private dequeue(): Promise<ExecutionInstruction | null> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift() ?? null)
    }
    if (this.stopped) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.waiters.push((instruction) => {
        if (this.stopped && instruction.action === '__stop__') {
          resolve(null)
        } else {
          resolve(instruction)
        }
      })
    })
  }
}
