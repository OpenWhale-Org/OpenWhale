import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'

type Waiter = (instruction: ExecutionInstruction) => void

let messageCounter = 0
function nextMessageId(): string {
  return `mem-${Date.now()}-${++messageCounter}`
}

const STOP: ExecutionInstruction = { messageId: '__stop__', executorId: '__stop__', action: '__stop__', params: {} }

export class MemoryExecutionQueue implements ExecutionQueue {
  /** Per-executorId queues */
  private readonly queues = new Map<string, ExecutionInstruction[]>()
  /** Per-executorId waiters (consumers blocked on empty queue) */
  private readonly waiters = new Map<string, Waiter[]>()
  /**
   * Per-executorId consumer generation. cancelConsumers bumps it; consume
   * loops entered under an older generation exit at their next iteration —
   * the hot-plugin-replace path, where the NEW executor object must take over
   * the id and the old object's loop must stop claiming instructions.
   */
  private readonly generations = new Map<string, number>()
  private stopped = false

  async push(instruction: ExecutionInstruction): Promise<void> {
    if (this.stopped) return
    const stamped = { ...instruction, messageId: instruction.messageId || nextMessageId() }
    const { executorId } = stamped
    const waiter = this.waiters.get(executorId)?.shift()
    if (waiter) {
      waiter(stamped)
    } else {
      if (!this.queues.has(executorId)) this.queues.set(executorId, [])
      this.queues.get(executorId)!.push(stamped)
    }
  }

  async pushBatch(instructions: ExecutionInstruction[]): Promise<void> {
    for (const instruction of instructions) {
      await this.push(instruction)
    }
  }

  async consume(executorId: string, handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void> {
    const generation = this.generations.get(executorId) ?? 0
    while (!this.stopped && (this.generations.get(executorId) ?? 0) === generation) {
      const instruction = await this.dequeue(executorId, generation)
      if (instruction === null) break
      await handler(instruction)
    }
  }

  /**
   * Detach every current consumer of an executorId (queued instructions stay
   * put for the next consumer). In-flight handlers finish; the loops exit
   * before claiming another instruction.
   */
  cancelConsumers(executorId: string): void {
    this.generations.set(executorId, (this.generations.get(executorId) ?? 0) + 1)
    for (const waiter of (this.waiters.get(executorId) ?? []).splice(0)) {
      waiter(STOP)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    // Wake up all blocked consumers so they can exit their loops
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters.splice(0)) {
        waiter(STOP)
      }
    }
  }

  private dequeue(executorId: string, generation: number): Promise<ExecutionInstruction | null> {
    const queue = this.queues.get(executorId)
    if (queue && queue.length > 0) {
      return Promise.resolve(queue.shift() ?? null)
    }
    if (this.stopped) return Promise.resolve(null)
    return new Promise((resolve) => {
      if (!this.waiters.has(executorId)) this.waiters.set(executorId, [])
      this.waiters.get(executorId)!.push((instruction) => {
        const cancelled = (this.generations.get(executorId) ?? 0) !== generation
        if ((this.stopped || cancelled) && instruction.action === '__stop__') {
          resolve(null)
        } else {
          resolve(instruction)
        }
      })
    })
  }
}
