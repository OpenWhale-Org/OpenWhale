import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import { BaseStrategy } from '../../strategy/BaseStrategy.js'
import { BaseExecutor } from '../../executor/BaseExecutor.js'
import { BaseMonitor, MonitorMode } from '../../monitor/BaseMonitor.js'
import type { ExecutionInstruction, ExecutionQueue, ExecutionResult } from '../../types/executor.js'
import type { StrategyContext } from '../../types/strategy.js'
import type { StrategyParams } from '../../types/instance.js'
import type { Trigger } from '../../types/trigger.js'
import type { CredentialStore } from '../../types/credential.js'
import type { OpenWhalePlugin } from '../../plugin/PluginManager.js'

/**
 * Editing an instance WITHOUT stopping it first.
 *
 * The invariant being defended is not "the stored row changed" — it is that
 * the machinery actually running matches what is stored. A strategy derives
 * its triggers and subscriptions from its params once, at activation, so these
 * tests assert on what the instance SUBSCRIBES to after an edit, not on what
 * the store says.
 */

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-liveedit-test-'))

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'test', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

class CapturingQueue implements ExecutionQueue {
  readonly received: ExecutionInstruction[] = []
  async push(i: ExecutionInstruction) { this.received.push(i) }
  async pushBatch(is: ExecutionInstruction[]) { this.received.push(...is) }
  async consume() {}
  async stop() {}
}

class FakeTickerMonitor extends BaseMonitor<string, { price: number }> {
  override readonly mode = MonitorMode.Standalone
  get monitorName() { return 'ticker' }
  protected override startStandalone(): void {}
  protected override stopStandalone(): void {}
  protected override async append(): Promise<void> {}
  async fire(key: string, data: { price: number }) { await this.push(key, data) }
}

class FakeExecutor extends BaseExecutor<ExecutionInstruction> {
  constructor() { super() }
  get executorName() { return 'trade' }
  get supportedActions() { return ['noop'] }
  async execute(i: ExecutionInstruction): Promise<ExecutionResult<ExecutionInstruction>> {
    return { instruction: i, status: 'success', executedAt: new Date() }
  }
}

const decls = {
  monitors: [{ name: 'ticker', label: 'price' }],
  executors: [{ name: 'trade', label: 'exec' }],
} as const

/** Its subscription key IS a param, so an edit that took effect is observable. */
class SymbolStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'momentum'
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly baseParamsSchema = z.object({ symbol: z.string() })

  override triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const { symbol } = this.baseParamsSchema.parse(params.base)
    return [{
      enabled: true,
      conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('price'), key: symbol }] }],
    }]
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    for (const symbol of ['BTC', 'ETH']) {
      const tick = context.getData('price', symbol)
      if (tick) return [this.instruction('exec', 'noop', { symbol, price: tick.price })]
    }
    return []
  }
}

const monitor = new FakeTickerMonitor()

function testPlugin(): OpenWhalePlugin {
  const now = new Date().toISOString()
  return {
    name: 'testex',
    version: '0.0.1',
    monitors: [{ definition: { id: 'ticker', name: 'Ticker', source: 'plugin', createdAt: now, updatedAt: now }, instance: monitor }],
    executors: [{ definition: { id: 'trade', name: 'Trade', source: 'plugin', supportedActions: ['noop'], createdAt: now, updatedAt: now }, instance: new FakeExecutor() }],
    strategies: [{ definition: { id: 'momentum', name: 'Momentum', source: 'plugin', createdAt: now, updatedAt: now }, factory: () => new SymbolStrategy() }],
  }
}

/**
 * A dataDir PER TEST. A shared one made every runtime auto-resume the
 * instances the previous tests had left enabled, so the queue counted their
 * firings too — the assertions drifted by however many tests ran first.
 */
async function bootWithActiveInstance(id: string) {
  const dataDir = fs.mkdtempSync(path.join(tmpRoot, `${id}-`))
  const queue = new CapturingQueue()
  const runtime = new OpenWhaleRuntime({ dataDir, credentialStore, queue })
  runtime.loadPlugin(testPlugin, {})
  await runtime.start()
  const now = new Date().toISOString()
  await runtime.activate({
    id, name: 'Test', strategyId: 'testex/momentum',
    params: { base: { symbol: 'BTC' }, tunable: {} },
    enabled: true, createdAt: now, updatedAt: now,
  })
  return { runtime, queue }
}

describe('editing a running instance', () => {
  afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }))

  it('refuses by default — an edit that silently desynced the running strategy would be worse', async () => {
    const { runtime } = await bootWithActiveInstance('inst-refuse')
    await expect(runtime.updateInstance('inst-refuse', { params: { base: { symbol: 'ETH' }, tunable: {} } }))
      .rejects.toThrow(/is active/)
    await runtime.stop()
  })

  it('restart rebuilds the subscriptions from the new params', async () => {
    const { runtime, queue } = await bootWithActiveInstance('inst-restart')

    await monitor.fire('BTC', { price: 1 })
    expect(queue.received).toHaveLength(1)

    await runtime.updateInstance(
      'inst-restart', { params: { base: { symbol: 'ETH' }, tunable: {} } }, { restart: true },
    )

    // The proof the restart actually happened: the trigger follows the NEW
    // param. A save that only touched the store would still fire on BTC.
    await monitor.fire('BTC', { price: 2 })
    expect(queue.received).toHaveLength(1)

    await monitor.fire('ETH', { price: 3 })
    expect(queue.received).toHaveLength(2)
    expect(queue.received[1]).toMatchObject({ params: { symbol: 'ETH', price: 3 } })

    await runtime.stop()
  })

  it('stays enabled and running, so a reboot resumes it', async () => {
    const { runtime } = await bootWithActiveInstance('inst-enabled')
    await runtime.updateInstance(
      'inst-enabled', { params: { base: { symbol: 'ETH' }, tunable: {} } }, { restart: true },
    )
    const view = (await runtime.listInstanceViews()).find(i => i.id === 'inst-enabled')
    expect(view?.active).toBe(true)
    expect(view?.enabled).toBe(true)
    await runtime.stop()
  })

  // The dangerous case: params the strategy rejects. Deactivate-edit-activate
  // done by hand would leave the instance stopped and the operator unaware.
  it('a rejected edit rolls back and leaves the instance running as before', async () => {
    const { runtime, queue } = await bootWithActiveInstance('inst-rollback')

    await expect(runtime.updateInstance(
      'inst-rollback',
      { params: { base: { symbol: 42 as unknown as string }, tunable: {} } },
      { restart: true },
    )).rejects.toThrow(/rolled back/)

    // Still live, still on the old key
    await monitor.fire('BTC', { price: 9 })
    expect(queue.received).toHaveLength(1)
    expect((await runtime.listInstanceViews()).find(i => i.id === 'inst-rollback')?.active).toBe(true)

    await runtime.stop()
  })

  it('the rolled-back params are the ones that survive', async () => {
    const { runtime } = await bootWithActiveInstance('inst-rollback-params')
    await expect(runtime.updateInstance(
      'inst-rollback-params',
      { name: 'Renamed', params: { base: { symbol: 42 as unknown as string }, tunable: {} } },
      { restart: true },
    )).rejects.toThrow()

    const view = (await runtime.listInstanceViews()).find(i => i.id === 'inst-rollback-params')
    expect(view?.name).toBe('Test')     // the rename went with the rejected edit
    await runtime.stop()
  })

  it('a stopped instance is edited in place, not started', async () => {
    const { runtime } = await bootWithActiveInstance('inst-stopped')
    await runtime.deactivate('inst-stopped')

    await runtime.updateInstance(
      'inst-stopped', { params: { base: { symbol: 'ETH' }, tunable: {} } }, { restart: true },
    )

    const view = (await runtime.listInstanceViews()).find(i => i.id === 'inst-stopped')
    expect(view?.active).toBe(false)
    expect(view?.enabled).toBe(false)
    await runtime.stop()
  })
})
