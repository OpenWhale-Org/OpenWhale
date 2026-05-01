import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'

type Waiter = (instruction: ExecutionInstruction) => void

export class MemoryExecutionQueue implements ExecutionQueue {
  /** Per-executorId queues */
  private readonly queues = new Map<string, ExecutionInstruction[]>()
  /** Per-executorId waiters (consumers blocked on empty queue) */
  private readonly waiters = new Map<string, Waiter[]>()
  private stopped = false

  async push(instruction: ExecutionInstruction): Promise<void> {
    if (this.stopped) return
    const { executorId } = instruction
    const waiter = this.waiters.get(executorId)?.shift()
    if (waiter) {
      waiter(instruction)
    } else {
      if (!this.queues.has(executorId)) this.queues.set(executorId, [])
      this.queues.get(executorId)!.push(instruction)
    }
  }

  async pushBatch(instructions: ExecutionInstruction[]): Promise<void> {
    for (const instruction of instructions) {
      await this.push(instruction)
    }
  }

  async consume(executorId: string, handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void> {
    while (!this.stopped) {
      const instruction = await this.dequeue(executorId)
      if (instruction === null) break
      await handler(instruction)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    // Wake up all blocked consumers so they can exit their loops
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters.splice(0)) {
        waiter({ executorId: '__stop__', action: '__stop__', params: {} })
      }
    }
  }

  private dequeue(executorId: string): Promise<ExecutionInstruction | null> {
    const queue = this.queues.get(executorId)
    if (queue && queue.length > 0) {
      return Promise.resolve(queue.shift() ?? null)
    }
    if (this.stopped) return Promise.resolve(null)
    return new Promise((resolve) => {
      if (!this.waiters.has(executorId)) this.waiters.set(executorId, [])
      this.waiters.get(executorId)!.push((instruction) => {
        if (this.stopped && instruction.action === '__stop__') {
          resolve(null)
        } else {
          resolve(instruction)
        }
      })
    })
  }
}
