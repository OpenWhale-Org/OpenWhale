import { describe, it, expect } from 'vitest'
import { MemoryExecutionQueue } from '../MemoryExecutionQueue.js'
import type { ExecutionInstruction } from '../../types/executor.js'

const instr = (n: number): ExecutionInstruction =>
  ({ messageId: `m${n}`, executorId: 'exec', action: 'go', params: {} })

async function tick() { await new Promise(r => setTimeout(r, 10)) }

describe('MemoryExecutionQueue.cancelConsumers — hot plugin replace', () => {
  it('a replaced consumer stops claiming; the new one takes over the id', async () => {
    const queue = new MemoryExecutionQueue()
    const oldSeen: string[] = []
    const newSeen: string[] = []

    const oldLoop = queue.consume('exec', async (i) => { oldSeen.push(i.messageId) })
    await tick()

    // Hot replace: detach the old loop, attach the new object's loop
    queue.cancelConsumers('exec')
    const newLoop = queue.consume('exec', async (i) => { newSeen.push(i.messageId) })
    await tick()
    await expect(Promise.race([oldLoop, tick().then(() => 'pending')])).resolves.not.toBe('pending')

    await queue.push(instr(1))
    await queue.push(instr(2))
    await tick()

    expect(oldSeen).toEqual([])            // the stale loop claimed nothing
    expect(newSeen).toEqual(['m1', 'm2'])  // the replacement got everything

    await queue.stop()
    await newLoop
  })

  it('instructions queued before the replacement survive for the new consumer', async () => {
    const queue = new MemoryExecutionQueue()
    await queue.push(instr(1))             // queued with no consumer at all

    queue.cancelConsumers('exec')          // replace with nobody attached — harmless
    const seen: string[] = []
    const loop = queue.consume('exec', async (i) => { seen.push(i.messageId) })
    await tick()

    expect(seen).toEqual(['m1'])
    await queue.stop()
    await loop
  })
})
