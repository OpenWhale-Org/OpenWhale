import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import { BaseStrategy } from '../../strategy/BaseStrategy.js'
import { BaseMonitor, MonitorMode } from '../../monitor/BaseMonitor.js'
import { MemoryExecutionQueue } from '../../executor/MemoryExecutionQueue.js'
import type { StrategyContext } from '../../types/strategy.js'
import type { Trigger } from '../../types/trigger.js'
import type { ExecutionInstruction } from '../../types/executor.js'
import type { CredentialStore } from '../../types/credential.js'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'

/**
 * Quick and pinned parameters: the strategy names its defaults on the field
 * meta, the operator may override them per instance (at most three pinned),
 * and a running instance reports the monitor sources its board should draw.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-quick-'))
const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'test', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

class TickMonitor extends BaseMonitor<string, { v: number }> {
  override readonly mode = MonitorMode.Standalone
  get monitorName() { return 'tick' }
  override get keySchema() { return z.object({ symbol: z.string() }) }
  protected override startStandalone(): void {}
  protected override stopStandalone(): void {}
  protected override async append(): Promise<void> {}
}

class Sized extends BaseStrategy {
  readonly strategyId = 'sized'
  override readonly monitors = [{ name: 'tick', label: 'tick' }]
  override readonly executors = []
  override readonly baseParamsSchema = z.object({
    symbol: z.string().meta({ displayName: 'Symbol' }),
    notional: z.number().meta({ displayName: 'Notional', pinned: true }),
  })
  override readonly tunableParamsSchema = z.object({
    entryPct: z.number().default(1).meta({ displayName: 'Entry %', quick: true }),
    stop: z.number().default(3).meta({ displayName: 'Stop' }),
  })
  triggers(): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const symbol = String((this.params.base as { symbol: string }).symbol)
    return [{ enabled: true, conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('tick'), key: '', keyParams: { symbol } }] }] }]
  }
  async evaluate(_ctx: StrategyContext): Promise<ExecutionInstruction[]> { return [] }
}

async function harness() {
  const database = new SQLiteAdapter({ filePath: path.join(tmpDir, `${Math.random().toString(36).slice(2)}.db`) })
  await database.initialize()
  const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, database, queue: new MemoryExecutionQueue() })
  const now = new Date().toISOString()
  runtime.registerMonitor({ id: 'tick', name: 'Tick', source: 'builtin', createdAt: now, updatedAt: now }, new TickMonitor())
  runtime.registerStrategy({ id: 'sized', name: 'Sized', source: 'builtin', createdAt: now, updatedAt: now }, () => new Sized())
  await runtime.start()
  return runtime
}

describe('quick and pinned parameters', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('the field meta reaches the definition, and pinned implies quick', async () => {
    const runtime = await harness()
    const fields = runtime.listStrategies().find(s => s.id === 'sized')!.paramsFields!
    expect(fields.find(f => f.name === 'notional')).toMatchObject({ quick: true, pinned: true })
    expect(fields.find(f => f.name === 'entryPct')).toMatchObject({ quick: true })
    expect(fields.find(f => f.name === 'entryPct')!.pinned).toBeUndefined()
    expect(fields.find(f => f.name === 'stop')!.quick).toBeUndefined()
    await runtime.stop()
  })

  it('the operator overrides the sets per instance, three pinned at most, null restores the defaults', async () => {
    const runtime = await harness()
    const now = new Date().toISOString()
    const inst = { id: 'q1', name: 'q1', strategyId: 'sized', credentials: {}, enabled: false, createdAt: now, updatedAt: now, params: { base: { symbol: 'X', notional: 1 }, tunable: {} } }
    await runtime.saveInstance(inst)
    const patched = await runtime.updateInstanceMeta(inst.id, { quickParams: ['stop', 'stop'], pinnedParams: ['stop'] })
    expect(patched.quickParams).toEqual(['stop'])
    expect(patched.pinnedParams).toEqual(['stop'])
    await expect(runtime.updateInstanceMeta(inst.id, { pinnedParams: ['a', 'b', 'c', 'd'] })).rejects.toThrow(/three/)
    const restored = await runtime.updateInstanceMeta(inst.id, { quickParams: null, pinnedParams: [] })
    expect(restored.quickParams).toBeUndefined()
    expect(restored.pinnedParams).toEqual([])
    await runtime.stop()
  })

  it('a running instance reports its monitor sources with resolved keys; a stopped one none', async () => {
    const runtime = await harness()
    const now = new Date().toISOString()
    const inst = { id: 's1', name: 's1', strategyId: 'sized', credentials: {}, enabled: true, createdAt: now, updatedAt: now, params: { base: { symbol: 'BTC', notional: 1 }, tunable: {} } }
    expect(runtime.instanceSources('s1')).toEqual([])
    await runtime.activate(inst)
    expect(runtime.instanceSources('s1')).toEqual([{ monitorName: 'tick', key: 'BTC' }])
    await runtime.deactivate('s1')
    expect(runtime.instanceSources('s1')).toEqual([])
    await runtime.stop()
  })
})
