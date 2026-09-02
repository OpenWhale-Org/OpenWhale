import { describe, it, expect } from 'vitest'
import { BaseStrategy } from '../BaseStrategy.js'
import type { ExecutionInstruction, StrategyContext } from '../../types/index.js'

/**
 * An execution says an order was sent; the run says why. Matching the two by
 * timestamp is a guess the moment two runs overlap — and they do, since a
 * trigger can fire while the previous run is still awaiting a venue. So the
 * run stamps its own id on every instruction it emits, and the trace carries
 * the same one.
 */

class Emitter extends BaseStrategy {
  readonly strategyId = 'emitter'
  constructor(private readonly emit: ExecutionInstruction[]) { super() }
  async evaluate(_ctx: StrategyContext): Promise<ExecutionInstruction[]> {
    return this.emit
  }
}

const ctx = { triggerId: 't1', monitorData: {} } as unknown as StrategyContext
const instruction = (action: string): ExecutionInstruction =>
  ({ executorId: 'exec', messageId: action, action, params: {} })

describe('a run stamps the instructions it emitted', () => {
  it('gives every instruction the id its own trace carries', async () => {
    const s = new Emitter([instruction('place'), instruction('cancel')])
    const emitted = await s.run(ctx)
    const trace = s.getRecentRuns()[0]!

    expect(trace.runId).toBeTruthy()
    expect(emitted.map(i => i.runId)).toEqual([trace.runId, trace.runId])
  })

  it('gives consecutive runs different ids', async () => {
    const s = new Emitter([instruction('place')])
    const first = (await s.run(ctx))[0]!.runId
    const second = (await s.run(ctx))[0]!.runId

    expect(first).toBeTruthy()
    expect(second).not.toBe(first)
    expect(s.getRecentRuns().map(r => r.runId)).toEqual([second, first])
  })

  it('leaves an id the strategy set itself alone', async () => {
    const s = new Emitter([{ ...instruction('place'), runId: 'run:from-somewhere-else' }])
    expect((await s.run(ctx))[0]!.runId).toBe('run:from-somewhere-else')
  })
})
