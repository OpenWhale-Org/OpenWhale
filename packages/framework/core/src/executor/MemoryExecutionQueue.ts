import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('ExecutionQueue')

/**
 * How long an instruction may sit with nobody consuming its executorId before
 * the queue says so. Long enough to cover the ordinary startup race, where a
 * strategy emits before its executor's consume loop has been entered.
 */
const ORPHAN_GRACE_MS = 15_000

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
  /**
   * Live consume loops per executorId.
   *
   * Pushing to an id nobody consumes used to be silent: the instruction went
   * into `queues` and stayed there. On 2026-11-10 that swallowed every V2
   * funding cycle for five hours — the strategy logged the plan as handed
   * over, the engine's socket was healthy and idle, and nothing anywhere said
   * the instruction had no consumer. An executor whose loop exits without a
   * replacement (a failed hot-replace, a re-activation that threw) is exactly
   * the case worth shouting about, so the count is kept and checked.
   */
  private readonly consumers = new Map<string, number>()
  /** One pending orphan check per executorId — not one per instruction. */
  private readonly orphanChecks = new Map<string, ReturnType<typeof setTimeout>>()
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
      this.watchForOrphan(executorId)
    }
  }

  /**
   * Say so when instructions pile up for an executorId nobody consumes.
   *
   * Deferred rather than immediate: at startup a strategy can emit before the
   * executor's consume loop is entered, and that race resolves itself within
   * milliseconds. What never resolves is a queue whose consumer is gone — so
   * the check runs once, after the grace period, and only reports if the
   * backlog is still sitting there unconsumed.
   */
  private watchForOrphan(executorId: string): void {
    if (this.orphanChecks.has(executorId)) return
    const timer = setTimeout(() => {
      this.orphanChecks.delete(executorId)
      const waiting = this.queues.get(executorId)?.length ?? 0
      if (this.stopped || waiting === 0) return
      if ((this.consumers.get(executorId) ?? 0) > 0) return
      log.error(
        { executorId, waiting, forMs: ORPHAN_GRACE_MS },
        'Instructions are queued for an executor nobody consumes — they will sit here until a consumer attaches',
      )
    }, ORPHAN_GRACE_MS)
    timer.unref?.()
    this.orphanChecks.set(executorId, timer)
  }

  async pushBatch(instructions: ExecutionInstruction[]): Promise<void> {
    for (const instruction of instructions) {
      await this.push(instruction)
    }
  }

  async consume(executorId: string, handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void> {
    const generation = this.generations.get(executorId) ?? 0
    this.consumers.set(executorId, (this.consumers.get(executorId) ?? 0) + 1)
    try {
      while (!this.stopped && (this.generations.get(executorId) ?? 0) === generation) {
        const instruction = await this.dequeue(executorId, generation)
        if (instruction === null) break
        await handler(instruction)
      }
    } finally {
      const left = (this.consumers.get(executorId) ?? 1) - 1
      if (left > 0) this.consumers.set(executorId, left)
      else {
        this.consumers.delete(executorId)
        // The loop that just exited may have been the only one. Whatever it
        // leaves behind has nobody to take it, which is worth the same check.
        if ((this.queues.get(executorId)?.length ?? 0) > 0) this.watchForOrphan(executorId)
      }
    }
  }

  /** Live consume loops for an executorId — for "why is nothing executing". */
  consumerCount(executorId: string): number {
    return this.consumers.get(executorId) ?? 0
  }

  /** Instructions waiting for a consumer, per executorId. */
  backlog(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [id, queue] of this.queues) if (queue.length > 0) out.set(id, queue.length)
    return out
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
    for (const timer of this.orphanChecks.values()) clearTimeout(timer)
    this.orphanChecks.clear()
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
