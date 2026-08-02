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
 * End-to-end coverage of the namespaced activation path — the route the
 * dashboard actually uses: loadPlugin → activate → monitor emit → strategy
 * evaluate → instruction queued with the executor's REGISTRY KEY (namespace
 * resolution happens entirely in the framework; the strategy speaks labels).
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-ns-test-'))

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

const testDecls = {
  monitors: [{ name: 'ticker', label: 'price' }],
  executors: [{ name: 'trade', label: 'exec' }],
} as const

class TestStrategy extends BaseStrategy<typeof testDecls> {
  readonly strategyId = 'momentum'
  override readonly monitors = testDecls.monitors
  override readonly executors = testDecls.executors
  override readonly baseParamsSchema = z.object({ symbol: z.string() })

  override triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const { symbol } = this.baseParamsSchema.parse(params.base)
    return [{
      enabled: true,
      conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('price'), key: symbol }] }],
    }]
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const tick = context.getData('price', 'BTC')
    if (!tick) return []
    return [this.instruction('exec', 'noop', { price: tick.price })]
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
    strategies: [{ definition: { id: 'momentum', name: 'Momentum', source: 'plugin', createdAt: now, updatedAt: now }, factory: () => new TestStrategy() }],
  }
}

describe('namespaced activation (loadPlugin path)', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('resolves labels to namespaced registry keys end-to-end', async () => {
    const queue = new CapturingQueue()
    const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, queue })
    runtime.loadPlugin(testPlugin, {})

    // Definition deps derived from class declarations, namespace applied
    const def = runtime.listStrategies().find(s => s.id === 'testex/momentum')
    expect(def).toBeDefined()
    expect(def!.monitorIds).toEqual(['testex/ticker'])
    expect(def!.executorIds).toEqual(['testex/trade'])
    expect(def!.paramsFields?.map(f => f.name)).toEqual(['symbol'])

    await runtime.start()
    const now = new Date().toISOString()
    await runtime.activate({
      id: 'inst-1', name: 'Test', strategyId: 'testex/momentum',
      params: { base: { symbol: 'BTC' }, tunable: {} },
      enabled: true, createdAt: now, updatedAt: now,
    })

    await monitor.fire('BTC', { price: 50000 })

    // The strategy emitted executorId as the LABEL 'exec'; the framework must
    // have rewritten it to the namespaced registry key when queueing.
    expect(queue.received).toHaveLength(1)
    expect(queue.received[0]).toMatchObject({
      executorId: 'testex/trade',
      action: 'noop',
      instanceId: 'inst-1',
      params: { price: 50000 },
    })

    await runtime.deactivate('inst-1')
    await monitor.fire('BTC', { price: 51000 })
    expect(queue.received).toHaveLength(1)  // deactivated instance no longer fires

    await runtime.stop()
  })
})
