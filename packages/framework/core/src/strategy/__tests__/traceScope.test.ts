import { describe, it, expect } from 'vitest'
import { BaseStrategy } from '../BaseStrategy.js'
import { createLogger } from '../../utils/logger.js'
import type { ExecutionInstruction, StrategyContext } from '../../types/index.js'

/**
 * A run trace is read as evidence, so it must not contain other components'
 * work. It used to: every line the process logged between a run's start and
 * end was appended, so an Aster pair's trace carried a Binance monitor's order
 * books for symbols that instance has never traded (2026-08-31). Wall-clock
 * overlap is not causation — a dozen monitor feeds and every other instance
 * are logging at the same moment.
 */

const outsider = createLogger('some-other-monitor')

class Probe extends BaseStrategy {
  readonly strategyId = 'probe'
  duringRun: (() => Promise<void>) | undefined
  /** Its own logger, as a strategy's code would use — `this.log` is private. */
  private readonly mine = createLogger('probe')

  async evaluate(_ctx: StrategyContext): Promise<ExecutionInstruction[]> {
    this.mine.info({ mine: true }, 'strategy speaking')
    await this.duringRun?.()
    return []
  }
}

const ctx = { triggerId: 't1', monitorData: {} } as unknown as StrategyContext

function stepsOf(s: Probe): Array<{ step: string; data?: Record<string, unknown> }> {
  return s.getRecentRuns()[0]!.steps as Array<{ step: string; data?: Record<string, unknown> }>
}

describe('run traces carry only the run', () => {
  it('keeps what the run itself logged', async () => {
    const s = new Probe()
    await s.run(ctx)
    const msgs = stepsOf(s).filter(x => x.step.startsWith('log:')).map(x => x.data?.msg)
    expect(msgs).toContain('strategy speaking')
  })

  it('drops a line another component logged during the same instant', async () => {
    const s = new Probe()
    // A monitor feed's own task: started outside the run, overlapping it in
    // time — which is precisely what the old timestamp rule could not tell
    // apart from the run's own work.
    const monitorFeed = new Promise<void>(resolve => setTimeout(() => {
      outsider.info({ venue: 'binance', etfSymbol: 'SQQQ/USDT:USDT' }, 'websocket fell back to polling')
      resolve()
    }, 1))
    s.duringRun = () => monitorFeed
    await Promise.all([s.run(ctx), monitorFeed])
    const msgs = stepsOf(s).filter(x => x.step.startsWith('log:')).map(x => String(x.data?.msg))
    expect(msgs).toContain('strategy speaking')
    expect(msgs.some(m => m.includes('websocket fell back'))).toBe(false)
  })

  it('keeps a line from work the run awaited, however deep', async () => {
    const s = new Probe()
    const deep = createLogger('venue-adapter')
    s.duringRun = async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 1))
      deep.info('order placed')
    }
    await s.run(ctx)
    const msgs = stepsOf(s).filter(x => x.step.startsWith('log:')).map(x => String(x.data?.msg))
    // setTimeout INSIDE the run inherits the scope: it is the run's own doing.
    expect(msgs).toContain('order placed')
  })
})
