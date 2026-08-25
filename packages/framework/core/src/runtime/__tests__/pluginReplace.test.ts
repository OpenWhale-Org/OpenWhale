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

  /* The reason a namespace can differ from a plugin's name at all: plugin
     names are not globally unique. Two people each publish a `funding-arb`,
     and without a namespace of its own the second one is not merely refused —
     its ids would collide with the first's, and the component registries are
     last-writer-wins, so it would quietly replace strategies that are running. */
  it('installs someone else\'s plugin of the same name under its own namespace', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'run-'))
    const runtime = new OpenWhaleRuntime({ dataDir: dir, credentialStore })
    runtime.loadPlugin(BOTH, {})
    const ns = runtime.loadPlugin(ALPHA_ONLY, {}, { as: 'alice-swappable' })

    expect(ns).toBe('alice-swappable')
    expect(runtime.listStrategies().map(s => s.id).sort())
      .toEqual(['alice-swappable/alpha', 'swappable/alpha', 'swappable/beta'])

    // Both are listed, and the stranger says what it actually calls itself
    const loaded = runtime.listLoadedPlugins()
    expect(loaded.map(p => p.name).sort()).toEqual(['alice-swappable', 'swappable'])
    expect(loaded.find(p => p.name === 'alice-swappable')?.declaredName).toBe('swappable')
    expect(loaded.find(p => p.name === 'swappable')?.declaredName).toBeUndefined()

    // Removing one leaves the other whole — separate namespaces, separate ids
    runtime.unloadPlugin('alice-swappable')
    expect(runtime.listStrategies().map(s => s.id).sort()).toEqual(['swappable/alpha', 'swappable/beta'])
  })

  it('rejects a namespace that would not survive being half of an id', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'run-'))
    const runtime = new OpenWhaleRuntime({ dataDir: dir, credentialStore })
    // A '/' would split into a second segment and make `a/b/alpha` ambiguous.
    // An EMPTY alias is not an error — it means "use the declared name".
    for (const bad of ['alice/swappable', '-leading', 'has space', 'a/b']) {
      expect(() => runtime.loadPlugin(BOTH, {}, { as: bad }), `alias: ${bad}`).toThrow()
      runtime.listLoadedPlugins().forEach(p => runtime.unloadPlugin(p.name))
    }
  })

  /* Not everything a plugin registers is namespaced, and the parts that are
     not are the reason a namespace cannot always rescue a collision. An
     adapter cell is addressed by (kind, venue) — that IS how a session is
     resolved — so a venue has exactly one provider, whatever the plugins are
     called. Same for credential types, which are shared by name on purpose. */
  it('refuses a second provider of the same cell or credential type, namespace or not', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'run-'))
    const runtime = new OpenWhaleRuntime({ dataDir: dir, credentialStore })

    const venuePlugin = (): OpenWhalePlugin => ({
      name: 'venue', version: '1',
      adapters: [{ kind: 'demo/rates', venue: 'boros', create: () => ({}) }],
      credentialTypes: [{ type: 'demo/key', raw: true }],
    })
    runtime.loadPlugin(venuePlugin, {})

    // A namespace of its own does not make room for it
    expect(() => runtime.loadPlugin(venuePlugin, {}, { as: 'venue-2' }))
      .toThrow(/\(demo\/rates, boros\).*already registered by plugin "venue"/s)

    const credentialClash = (): OpenWhalePlugin => ({
      name: 'other', version: '1',
      credentialTypes: [{ type: 'demo/key', raw: true }],
    })
    expect(() => runtime.loadPlugin(credentialClash, {}))
      .toThrow(/Credential type "demo\/key" is already registered by plugin "venue"/)
  })

  /* Whether a same-named stranger can be installed alongside depends on what
     it registers, and the answer is knowable BEFORE asking the user to pick a
     namespace. Offering one to a venue plugin whose cells are taken offers
     something that cannot work — accepted, run, and failed on the first cell. */
  it('says up front whether a namespace of its own would even work', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'run-'))
    const runtime = new OpenWhaleRuntime({ dataDir: dir, credentialStore })

    runtime.loadPlugin((): OpenWhalePlugin => ({
      name: 'pendle', version: '1',
      adapters: [{ kind: 'demo/rates', venue: 'boros', create: () => ({}) }],
      credentialTypes: [{ type: 'demo/agent', raw: true }],
    }), {})

    // Somebody else's `pendle`, also a venue plugin for the same venue
    try {
      runtime.loadPlugin((): OpenWhalePlugin => ({
        name: 'pendle', version: '9',
        adapters: [{ kind: 'demo/rates', venue: 'boros', create: () => ({}) }],
        credentialTypes: [{ type: 'demo/agent', raw: true }],
      }), {})
      expect.unreachable()
    } catch (err) {
      const e = err as PluginAlreadyLoadedError
      expect(e.blockedBy.map(c => `${c.what} ${c.name} <- ${c.owner}`)).toEqual([
        'adapter cell (demo/rates, boros) <- pendle',
        'credential type demo/agent <- pendle',
      ])
    }

    // Somebody else's `pendle` that is only strategies — nothing global, so a
    // namespace of its own is a real option and is reported as one
    const strategyOnly = (): OpenWhalePlugin => {
      const now = new Date().toISOString()
      const Cls = strategyClass('alpha')
      return {
        name: 'pendle', version: '9',
        strategies: [{ definition: { id: 'alpha', name: 'alpha', source: 'plugin', createdAt: now, updatedAt: now }, factory: () => new Cls() }],
      }
    }
    try {
      runtime.loadPlugin(strategyOnly, {})
      expect.unreachable()
    } catch (err) {
      expect((err as PluginAlreadyLoadedError).blockedBy).toEqual([])
    }
    // …and taking that option works
    expect(runtime.loadPlugin(strategyOnly, {}, { as: 'alice-pendle' })).toBe('alice-pendle')
    expect(runtime.listStrategies().map(s => s.id)).toContain('alice-pendle/alpha')
  })

  /* A refused registration must leave nothing behind. Half of a plugin used to
     stay registered with no loadedPlugins entry to find it by, so unloadPlugin
     answered "Plugin not loaded" and the next attempt failed on the wreckage
     of the last one instead of on the real cause. */
  it('rolls back completely when a registration is refused partway', async () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'run-'))
    const runtime = new OpenWhaleRuntime({ dataDir: dir, credentialStore })
    runtime.loadPlugin((): OpenWhalePlugin => ({
      name: 'incumbent', version: '1',
      credentialTypes: [{ type: 'shared/key', raw: true }],
    }), {})

    // Registers a strategy and a cell FIRST, then trips on the credential type
    const latecomer = (): OpenWhalePlugin => {
      const now = new Date().toISOString()
      const Cls = strategyClass('alpha')
      return {
        name: 'latecomer', version: '1',
        adapters: [{ kind: 'demo/rates', venue: 'boros', create: () => ({}) }],
        strategies: [{ definition: { id: 'alpha', name: 'alpha', source: 'plugin', createdAt: now, updatedAt: now }, factory: () => new Cls() }],
        credentialTypes: [{ type: 'shared/key', raw: true }],
      }
    }
    expect(() => runtime.loadPlugin(latecomer, {})).toThrow(/shared\/key/)

    expect(runtime.listLoadedPlugins().map(p => p.name)).toEqual(['incumbent'])
    expect(runtime.listStrategies().map(s => s.id)).not.toContain('latecomer/alpha')
    // The cell it did register is gone, so a corrected retry is not blocked by it
    expect(() => runtime.loadPlugin((): OpenWhalePlugin => ({
      name: 'latecomer', version: '2',
      adapters: [{ kind: 'demo/rates', venue: 'boros', create: () => ({}) }],
    }), {})).not.toThrow()
    // …and the incumbent still owns what was always its own
    expect(runtime.listCredentialTypes().filter(t => t.type === 'shared/key')).toHaveLength(1)
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
