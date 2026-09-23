import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { BaseExecutor } from '../BaseExecutor.js'
import { MemoryExecutionQueue } from '../MemoryExecutionQueue.js'
import type { ExecutionInstruction, ExecutionResult } from '../../types/executor.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-lanes-'))

/** Marks when each instruction starts and ends, so the test can see what overlapped. */
class LaneExecutor extends BaseExecutor {
  readonly marks: string[] = []
  constructor(maxConcurrent: number, private readonly durationMs: number, private readonly name = 'lanes') {
    super({ dataDir: tmpDir, maxConcurrent })
  }
  get executorName() { return this.name }
  get supportedActions() { return ['noop'] }
  /** Lanes come from the instruction: params.lanes, a comma-separated list. */
  protected override lanesOf(instruction: ExecutionInstruction): string[] {
    const raw = String((instruction.params as { lanes?: string }).lanes ?? '')
    return raw === '' ? [] : raw.split(',')
  }
  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult> {
    const tag = String((instruction.params as { tag?: string }).tag)
    this.marks.push(`start:${tag}`)
    await new Promise(resolve => setTimeout(resolve, this.durationMs))
    this.marks.push(`end:${tag}`)
    return { instruction, status: 'success', executedAt: new Date() }
  }
}

async function drain(ex: LaneExecutor, jobs: Array<{ tag: string; lanes?: string }>): Promise<void> {
  const queue = new MemoryExecutionQueue()
  const consuming = ex.run(queue, ex.executorName)
  for (const j of jobs) {
    await queue.push({ messageId: j.tag, executorId: ex.executorName, action: 'noop', params: { tag: j.tag, ...(j.lanes ? { lanes: j.lanes } : {}) } })
  }
  const deadline = Date.now() + 5_000
  while (ex.marks.filter(m => m.startsWith('end:')).length < jobs.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  await queue.stop()
  await consuming
}

describe('BaseExecutor lanes', () => {
  it('instructions sharing a lane keep their order; disjoint ones overlap', async () => {
    const ex = new LaneExecutor(4, 60, 'lanes-share')
    await drain(ex, [
      { tag: 'a1', lanes: 'main|SKHY' },
      { tag: 'a2', lanes: 'main|SKHY' },     // same symbol on the same account — must wait for a1
      { tag: 'b1', lanes: 'sub|MVLL' },      // nothing in common — runs alongside
    ])
    expect(ex.marks.indexOf('start:a2')).toBeGreaterThan(ex.marks.indexOf('end:a1'))
    expect(ex.marks.indexOf('start:b1')).toBeLessThan(ex.marks.indexOf('end:a1'))
  }, 10_000)

  it('an instruction waits for every lane it needs, not just the first', async () => {
    const ex = new LaneExecutor(4, 50, 'lanes-multi')
    await drain(ex, [
      { tag: 'x', lanes: 'main|BBB' },
      { tag: 'y', lanes: 'main|AAA' },
      { tag: 'both', lanes: 'main|BBB,main|AAA' },
    ])
    expect(ex.marks.indexOf('start:y')).toBeLessThan(ex.marks.indexOf('end:x'))   // x and y overlap
    expect(ex.marks.indexOf('start:both')).toBeGreaterThan(ex.marks.indexOf('end:x'))
    expect(ex.marks.indexOf('start:both')).toBeGreaterThan(ex.marks.indexOf('end:y'))
  }, 10_000)

  it('no lanes declared = the old behaviour, everything overlaps', async () => {
    const ex = new LaneExecutor(3, 60, 'lanes-none')
    await drain(ex, [{ tag: 'p' }, { tag: 'q' }, { tag: 'r' }])
    expect(ex.marks.slice(0, 3).sort()).toEqual(['start:p', 'start:q', 'start:r'])
  }, 10_000)
})
