import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { BaseExecutor } from '../BaseExecutor.js'
import { MemoryExecutionQueue } from '../MemoryExecutionQueue.js'
import type { ExecutionInstruction, ExecutionResult } from '../../types/executor.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-envelope-'))

/**
 * An executor with an instructionSchema — the path where the instruction is
 * rebuilt from zod's output. Everything the schema does not name is stripped,
 * so the framework's own fields have to be carried across by hand, and this
 * is the test that says which ones.
 */
class SchemaExecutor extends BaseExecutor {
  seen: ExecutionInstruction[] = []

  constructor() { super({ dataDir: tmpDir }) }

  get executorName() { return 'schema-exec' }
  get supportedActions() { return ['noop'] }
  // `as never` mirrors the real executors (PerpTradingExecutor and the
  // strategy plugins all do this): a schema describes action + params, not the
  // envelope, so it cannot satisfy ZodType<ExecutionInstruction> on its own.
  // That gap is precisely why the envelope has to be carried across by hand.
  protected override get instructionSchema() {
    return z.object({ action: z.literal('noop'), params: z.object({ n: z.number() }) }) as never
  }

  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult> {
    this.seen.push(instruction)
    return { instruction, status: 'success', executedAt: new Date() }
  }
}

async function push(instruction: Partial<ExecutionInstruction>): Promise<ExecutionInstruction> {
  const executor = new SchemaExecutor()
  const queue = new MemoryExecutionQueue()
  const consuming = executor.run(queue, executor.executorName)
  await queue.push({
    messageId: 'm1', executorId: 'schema-exec', action: 'noop', params: { n: 1 },
    ...instruction,
  } as ExecutionInstruction)
  const deadline = Date.now() + 3_000
  while (executor.seen.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  await queue.stop()
  await consuming
  expect(executor.seen).toHaveLength(1)
  return executor.seen[0]!
}

describe('instruction envelope survives schema validation', () => {
  it('carries runId through — without it every execution reads as "no run id"', async () => {
    const seen = await push({ runId: 'run:inst_x:1788000000000:7' })
    expect(seen.runId).toBe('run:inst_x:1788000000000:7')
  })

  it('carries instanceId, accountNames and executorId through', async () => {
    const seen = await push({ instanceId: 'inst_x', accountNames: ['A', 'B'] })
    expect(seen.instanceId).toBe('inst_x')
    expect(seen.accountNames).toEqual(['A', 'B'])
    expect(seen.executorId).toBe('schema-exec')
    expect(seen.messageId).toBe('m1')
  })

  it('still applies the schema to action and params', async () => {
    const seen = await push({ params: { n: 42 } })
    expect(seen.params).toEqual({ n: 42 })
  })

  it('omits envelope fields that were never set, rather than writing undefined', async () => {
    const seen = await push({})
    expect('runId' in seen).toBe(false)
    expect('instanceId' in seen).toBe(false)
  })
})
