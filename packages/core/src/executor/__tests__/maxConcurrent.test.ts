import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { BaseExecutor } from '../BaseExecutor.js'
import { MemoryExecutionQueue } from '../MemoryExecutionQueue.js'
import type { ExecutionInstruction, ExecutionResult } from '../../types/executor.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-concurrent-'))

class SlowExecutor extends BaseExecutor {
  active = 0
  maxObservedActive = 0
  completed = 0

  constructor(maxConcurrent: number, private readonly durationMs: number) {
    super({ dataDir: tmpDir, maxConcurrent })
  }

  get executorName() { return `slow-${this.durationMs}` }
  get supportedActions() { return ['noop'] }

  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult> {
    this.active++
    this.maxObservedActive = Math.max(this.maxObservedActive, this.active)
    await new Promise(resolve => setTimeout(resolve, this.durationMs))
    this.active--
    this.completed++
    return { instruction, status: 'success', executedAt: new Date() }
  }
}

async function runThree(executor: SlowExecutor): Promise<void> {
  const queue = new MemoryExecutionQueue()
  const consuming = executor.run(queue, executor.executorName)
  for (let i = 0; i < 3; i++) {
    await queue.push({ messageId: `m${i}`, executorId: executor.executorName, action: 'noop', params: {} })
  }
  const deadline = Date.now() + 5_000
  while (executor.completed < 3 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await queue.stop()
  await consuming
}

describe('BaseExecutor maxConcurrent', () => {
  it('default (1) keeps execution strictly serial', async () => {
    const executor = new SlowExecutor(1, 60)
    await runThree(executor)
    expect(executor.completed).toBe(3)
    expect(executor.maxObservedActive).toBe(1)
  }, 10_000)

  it('opt-in concurrency overlaps executions up to the cap', async () => {
    const executor = new SlowExecutor(2, 120)
    await runThree(executor)
    expect(executor.completed).toBe(3)
    expect(executor.maxObservedActive).toBe(2)
  }, 10_000)
})
