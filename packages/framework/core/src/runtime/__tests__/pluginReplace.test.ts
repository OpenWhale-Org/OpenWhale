import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import { BaseStrategy } from '../../strategy/BaseStrategy.js'
import { BaseExecutor } from '../../executor/BaseExecutor.js'
import { BaseMonitor, MonitorMode } from '../../monitor/BaseMonitor.js'
import { PluginAlreadyLoadedError } from '../../types/runtime.js'
import type { ExecutionInstruction, ExecutionResult } from '../../types/executor.js'
import type { StrategyContext } from '../../types/strategy.js'
import type { StrategyParams } from '../../types/instance.js'
import type { Trigger } from '../../types/trigger.js'
import type { CredentialStore } from '../../types/credential.js'
import type { OpenWhalePlugin } from '../../plugin/PluginManager.js'

/**
 * Replacing a plugin's code without taking the user's world with it.
 *
 * The bargain this file pins down: uninstall refuses while instances exist,
 * because they would be orphaned; a REPLACE keeps every one of them, because
 * the new version almost certainly still has the strategies they name. What
 * the new version dropped is left visible and broken rather than deleted, and
 * putting the old version back brings it all the way back — which only works
 * because nothing was thrown away in between.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-replace-test-'))

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'test', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

class Ticker extends BaseMonitor<string, { price: number }> {
  override readonly mode = MonitorMode.Standalone
  get monitorName() { return 'ticker' }
  protected override startStandalone(): void {}
  protected override stopStandalone(): void {}
  protected override async append(): Promise<void> {}
}

class Trader extends BaseExecutor<ExecutionInstruction> {
  constructor() { super() }   // BaseExecutor's constructor is protected
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

function strategyClass(id: string) {
  return class extends BaseStrategy<typeof decls> {
    readonly strategyId = id
    override readonly monitors = decls.monitors
    override readonly executors = decls.executors
    override readonly baseParamsSchema = z.object({ symbol: z.string() })
    override triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
      const { symbol } = this.baseParamsSchema.parse(params.base)
      return [{ enabled: true, conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('price'), key: symbol }] }] }]
    }
    async evaluate(_context: StrategyContext): Promise<ExecutionInstruction[]> { return [] }
  }
}

/** A version of the plugin providing exactly the named strategies. */
function version(strategyIds: string[]) {
  return (): OpenWhalePlugin => {
    const now = new Date().toISOString()
    return {
      name: 'swappable',
      version: strategyIds.join('+'),
      monitors: [{ definition: { id: 'ticker', name: 'Ticker', source: 'plugin', createdAt: now, updatedAt: now }, instance: new Ticker() }],
      executors: [{ definition: { id: 'trade', name: 'Trade', source: 'plugin', supportedActions: ['noop'], createdAt: now, updatedAt: now }, instance: new Trader() }],
      strategies: strategyIds.map(id => {
        const Cls = strategyClass(id)
        return { definition: { id, name: id, source: 'plugin' as const, createdAt: now, updatedAt: now }, factory: () => new Cls() }
      }),
    }
  }
}

const BOTH = version(['alpha', 'beta'])
const ALPHA_ONLY = version(['alpha'])

async function instance(runtime: OpenWhaleRuntime, id: string, strategyId: string) {
  const now = new Date().toISOString()
  await runtime.activate({
    id, name: id, strategyId,
    params: { base: { symbol: 'BTC' }, tunable: {} },
    enabled: true, createdAt: now, updatedAt: now,
  })
}

describe('replacing a plugin in place', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('keeps every instance, resumes what survives, and leaves the rest visible', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'run-'))
    const runtime = new OpenWhaleRuntime({ dataDir: dir, credentialStore })
    runtime.loadPlugin(BOTH, {})
    await runtime.start()
    await instance(runtime, 'inst-a', 'swappable/alpha')
    await instance(runtime, 'inst-b', 'swappable/beta')

    // ── the new version dropped `beta` ──────────────────────────────────────
    const result = await runtime.replacePlugin(ALPHA_ONLY, {})
    expect(result).toMatchObject({ name: 'swappable', replaced: true, resumed: ['inst-a'], orphaned: ['inst-b'] })

    // Nothing was deleted — that is the whole difference from uninstall
    const views = await runtime.listInstanceViews()
    expect(views.map(v => v.id).sort()).toEqual(['inst-a', 'inst-b'])

    const a = views.find(v => v.id === 'inst-a')!
    expect(a.active).toBe(true)
    expect(a.problem).toBeUndefined()

    // …and the orphan reads as broken, not merely stopped
    const b = views.find(v => v.id === 'inst-b')!
    expect(b.active).toBe(false)
    expect(b.problem).toMatch(/swappable\/beta.*not registered/)
    // Still enabled, so putting the strategy back is enough to revive it
    expect(b.enabled).toBe(true)

    // ── put the old version back ────────────────────────────────────────────
    const restored = await runtime.replacePlugin(BOTH, {})
    // inst-b comes back because its strategy exists again; inst-a is restarted
    // because every replace stops and restarts what the plugin is running
    expect(restored.resumed.sort()).toEqual(['inst-a', 'inst-b'])
    expect(restored.orphaned).toEqual([])

    const revived = (await runtime.listInstanceViews()).find(v => v.id === 'inst-b')!
    expect(revived.active).toBe(true)
    expect(revived.problem).toBeUndefined()

    await runtime.stop()
  })

  it('loads normally when nothing is there to replace', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'run-'))
    const runtime = new OpenWhaleRuntime({ dataDir: dir, credentialStore })
    const result = await runtime.replacePlugin(BOTH, {})
    expect(result).toMatchObject({ replaced: false, resumed: [], orphaned: [] })
    expect(runtime.listStrategies().map(s => s.id).sort()).toEqual(['swappable/alpha', 'swappable/beta'])
  })

  /* The signal the install path turns into "already installed — overwrite?".
     A plain load must keep refusing, or a second source would silently take
     over a plugin that is already running. */
  it('a plain load still refuses, and says which plugin collided', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'run-'))
    const runtime = new OpenWhaleRuntime({ dataDir: dir, credentialStore })
    runtime.loadPlugin(BOTH, {})
    try {
      runtime.loadPlugin(ALPHA_ONLY, {})
      expect.unreachable('a second load of the same plugin name must throw')
    } catch (err) {
      expect(err).toBeInstanceOf(PluginAlreadyLoadedError)
      expect((err as PluginAlreadyLoadedError).pluginName).toBe('swappable')
    }
  })

  /* Uninstall's promise, stated from the other side: a plugin with instances
     cannot simply be dropped. pluginDependents is what the gateway reads to
     refuse, and it must count a STOPPED instance too — its params are just as
     lost as a running one's. */
  it('reports dependents including stopped instances', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'run-'))
    const runtime = new OpenWhaleRuntime({ dataDir: dir, credentialStore })
    runtime.loadPlugin(BOTH, {})
    await runtime.start()
    await instance(runtime, 'inst-a', 'swappable/alpha')
    await instance(runtime, 'inst-b', 'swappable/beta')
    await runtime.deactivate('inst-b')

    const deps = await runtime.pluginDependents('swappable')
    expect(deps.instances.sort()).toEqual(['inst-a', 'inst-b'])
    await runtime.stop()
  })
})
