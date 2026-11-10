import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MemoryExecutionQueue } from '../MemoryExecutionQueue.js'
import type { ExecutionInstruction } from '../../types/executor.js'

const instruction = (executorId: string): ExecutionInstruction => ({
  messageId: '', executorId, action: 'go', params: {},
})

describe('MemoryExecutionQueue — instructions with no consumer', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('reports a backlog that no consume loop is attached to', async () => {
    const queue = new MemoryExecutionQueue()
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write)

    await queue.push(instruction('engine'))
    await queue.push(instruction('engine'))
    expect(queue.consumerCount('engine')).toBe(0)
    expect(queue.backlog().get('engine')).toBe(2)

    vi.advanceTimersByTime(15_000)
    spy.mockRestore()
    const reported = lines.filter(l => l.includes('nobody consumes'))
    expect(reported).toHaveLength(1)
    expect(reported[0]).toContain('"executorId":"engine"')
    expect(reported[0]).toContain('"waiting":2')
  })

  it('stays quiet when a consumer picks the work up within the grace period', async () => {
    const queue = new MemoryExecutionQueue()
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      lines.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    const seen: string[] = []

    await queue.push(instruction('arb'))
    void queue.consume('arb', async (i) => { seen.push(i.executorId) })
    await vi.advanceTimersByTimeAsync(0)

    expect(seen).toEqual(['arb'])
    vi.advanceTimersByTime(15_000)
    spy.mockRestore()
    expect(lines.filter(l => l.includes('nobody consumes'))).toHaveLength(0)
    expect(queue.consumerCount('arb')).toBe(1)
    await queue.stop()
  })

  it('counts loops, so a cancelled consumer leaves the id orphaned', async () => {
    const queue = new MemoryExecutionQueue()
    void queue.consume('engine', async () => {})
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.consumerCount('engine')).toBe(1)

    // What a failed hot-replace leaves behind: the old loop exits, no new one.
    queue.cancelConsumers('engine')
    await vi.advanceTimersByTimeAsync(0)
    expect(queue.consumerCount('engine')).toBe(0)

    await queue.push(instruction('engine'))
    expect(queue.backlog().get('engine')).toBe(1)
    await queue.stop()
  })
})
