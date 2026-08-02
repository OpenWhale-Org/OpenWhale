import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z, type ZodObject, type ZodRawShape } from 'zod'
import { OpenWhaleRuntime } from '../../runtime/OpenWhaleRuntime.js'
import { BaseMonitor, MonitorMode } from '../BaseMonitor.js'
import { MemoryExecutionQueue } from '../../executor/MemoryExecutionQueue.js'
import type { MonitorContext } from '../../types/monitorInstance.js'
import type { CredentialStore } from '../../types/credential.js'

/**
 * Monitor contract / implementation / instance:
 *  - one contract ('feed'), a generic implementation + a venue-specialized
 *    subclass (narrowed keySchema, credential-required)
 *  - dispatch: keyParams evaluated leaf-first; the specialization claims its
 *    venue, the generic parent serves the rest
 *  - single-active per implementation; (implementation, credential) unique
 *  - pending keys self-heal when a serving instance activates later
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-moninst-test-'))

const started: Record<string, string[]> = { generic: [], special: [] }
const runners: GenericFeedMonitor[] = []

class GenericFeedMonitor extends BaseMonitor<string, { v: number }> {
  override readonly mode = MonitorMode.Subscribe
  constructor(protected readonly ctx: MonitorContext) {
    super({ ...(ctx.dataDir !== undefined ? { dataDir: ctx.dataDir } : {}) })
    runners.push(this)
  }
  get monitorName() { return 'feed' }
  override get keySchema(): ZodObject<ZodRawShape> { return z.object({ venue: z.string() }) }
  protected override startSubscribe(key: string): void { started['generic']!.push(key) }
  protected override stopSubscribe(): void {}
  async fire(key: string, v: number) { await this.push(key, { v }) }
}

class CmcFeedMonitor extends GenericFeedMonitor {
  override get keySchema(): ZodObject<ZodRawShape> { return z.object({ venue: z.literal('cmc') }) }
  protected override startSubscribe(key: string): void {
    if (!this.ctx.credential) throw new Error('cmc feed needs a credential')
    started['special']!.push(key)
  }
}

const credentials: Record<string, { type: string }> = {
  'CMC Pro': { type: 'cmc' },
  'CMC Backup': { type: 'cmc' },
}

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async (name: string) => {
    const c = credentials[name]
    if (!c) throw new Error(`no credential ${name}`)
    return { type: c.type, data: { apiKey: `${name}-key` } }
  },
  delete: async () => undefined,
  list: async () => [],
}

function setupRuntime(): OpenWhaleRuntime {
  const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, queue: new MemoryExecutionQueue() })
  runtime.registerCredentialType({ type: 'cmc', raw: true })
  runtime.loadPlugin(() => ({
    name: 'feeds', version: '0.0.0', monitors: [], executors: [], strategies: [],
    monitorImplementations: [
      { id: 'feed', contract: 'feed', displayName: 'Feed (any venue)', create: (ctx) => new GenericFeedMonitor(ctx) },
      { id: 'cmc-feed', contract: 'feeds/feed', credential: { type: 'cmc', level: 'required' }, create: (ctx) => new CmcFeedMonitor(ctx) },
    ],
  }), {})
  return runtime
}

describe('monitor contract / implementation / instance', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('dispatches leaf-first: specialization claims its venue, generic serves the rest', async () => {
    started['generic'] = []; started['special'] = []
    const runtime = setupRuntime()
    const facade = runtime.getMonitor('feeds/feed')!
    expect(facade).toBeDefined()

    const generic = await runtime.createMonitorInstance({ implementation: 'feeds/feed' })
    const special = await runtime.createMonitorInstance({ implementation: 'feeds/cmc-feed', credential: 'CMC Pro' })
    await runtime.activateMonitorInstance(generic.id)
    await runtime.activateMonitorInstance(special.id)

    // Structured subscription (the trigger path): keyFor teaches dispatch the params
    const binanceKey = facade.keyFor({ venue: 'binance' })
    const cmcKey = facade.keyFor({ venue: 'cmc' })
    facade.subscribe(binanceKey)
    facade.subscribe(cmcKey)

    expect(started['generic']).toEqual(['binance'])
    expect(started['special']).toEqual(['cmc'])
  })

  it('rejects a second active instance of the same implementation (single-active)', async () => {
    const runtime = setupRuntime()
    const a = await runtime.createMonitorInstance({ implementation: 'feeds/cmc-feed', credential: 'CMC Pro' })
    const b = await runtime.createMonitorInstance({ implementation: 'feeds/cmc-feed', credential: 'CMC Backup' })
    await runtime.activateMonitorInstance(a.id)
    await expect(runtime.activateMonitorInstance(b.id)).rejects.toThrow(/single-active/)
    await runtime.deactivateMonitorInstance(a.id)
    await expect(runtime.activateMonitorInstance(b.id)).resolves.toBeUndefined()
  })

  it('rejects duplicate (implementation, credential) instances and missing required credential', async () => {
    const runtime = setupRuntime()
    await runtime.createMonitorInstance({ implementation: 'feeds/cmc-feed', credential: 'CMC Pro' })
    await expect(runtime.createMonitorInstance({ implementation: 'feeds/cmc-feed', credential: 'CMC Pro' }))
      .rejects.toThrow(/already exists/)
    await expect(runtime.createMonitorInstance({ implementation: 'feeds/cmc-feed' }))
      .rejects.toThrow(/requires a "cmc" credential/)
  })

  it('parks unserved keys and self-heals when an instance activates later', async () => {
    started['generic'] = []
    const runtime = setupRuntime()
    const facade = runtime.getMonitor('feeds/feed')!
    const key = facade.keyFor({ venue: 'binance' })
    facade.subscribe(key)   // nobody active yet — parked, no throw
    expect(runtime.monitorPendingKeys()['feeds/feed']).toEqual(['binance'])

    const generic = await runtime.createMonitorInstance({ implementation: 'feeds/feed' })
    await runtime.activateMonitorInstance(generic.id)
    expect(started['generic']).toEqual(['binance'])
    expect(runtime.monitorPendingKeys()['feeds/feed']).toBeUndefined()
  })

  it('keySchema option lists read the adapter matrix LIVE — late-loaded venues appear', async () => {
    const runtime = setupRuntime()

    class VenueListMonitor extends GenericFeedMonitor {
      override get keySchema(): ZodObject<ZodRawShape> {
        const venues = this.ctx.adapters.types('test/live')
        return z.object({
          venue: z.string().meta({ options: venues.map(v => ({ label: v, value: v })) }),
        })
      }
    }
    runtime.loadPlugin(() => ({
      name: 'live', version: '0.0.0', monitors: [], executors: [], strategies: [],
      adapters: [{ kind: 'test/live', type: 'venue-a', create: () => ({}) }],
      monitorImplementations: [{ id: 'live-feed', contract: 'live-feed', create: (ctx) => new VenueListMonitor(ctx) }],
    }), {})

    const optionsOf = () => {
      const def = runtime.listMonitors().find(d => d.id === 'live/live-feed')!
      return (def.keyFields?.find(f => f.name === 'venue')?.options ?? []).map(o => o.value)
    }
    expect(optionsOf()).toEqual(['venue-a'])

    // A venue plugin loaded AFTER the monitor's registration must show up
    runtime.loadPlugin(() => ({
      name: 'late-venue', version: '0.0.0', monitors: [], executors: [], strategies: [],
      adapters: [{ kind: 'test/live', type: 'venue-b', create: () => ({}) }],
    }), {})
    expect(optionsOf()).toEqual(['venue-a', 'venue-b'])
  })

  it('emissions from instances flow through the contract façade to subscribers', async () => {
    runners.length = 0
    const runtime = setupRuntime()
    const facade = runtime.getMonitor('feeds/feed')!
    const generic = await runtime.createMonitorInstance({ implementation: 'feeds/feed' })
    await runtime.activateMonitorInstance(generic.id)

    const seen: Array<[string, unknown]> = []
    facade.addEmitHandler(async (key, data) => { seen.push([key, data]) })
    const key = facade.keyFor({ venue: 'binance' })
    facade.subscribe(key)

    const view = (await runtime.listMonitorInstances()).find(v => v.id === generic.id)!
    expect(view.servingKeys).toEqual(['binance'])

    // Fire on the LIVE runner (the activation-constructed one is the last)
    const runner = runners[runners.length - 1]!
    await runner.fire('binance', 42)
    expect(seen).toEqual([['binance', { v: 42 }]])

    // Deactivation detaches forwarding — further emissions stay silent
    await runtime.deactivateMonitorInstance(generic.id)
    await runner.fire('binance', 43)
    expect(seen).toHaveLength(1)
  })
})
