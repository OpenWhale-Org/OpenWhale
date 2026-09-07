import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import { BaseStrategy } from '../../strategy/BaseStrategy.js'
import { MemoryExecutionQueue } from '../../executor/MemoryExecutionQueue.js'
import type { StrategyContext } from '../../types/strategy.js'
import type { Trigger } from '../../types/trigger.js'
import type { ExecutionInstruction } from '../../types/executor.js'
import type { ParamPreset, PickerOption, PresetContext } from '../../types/definition.js'
import type { CredentialStore } from '../../types/credential.js'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'

/**
 * Presets a strategy computes live: listed after the static ones, cached
 * by what the form sent, recomputed on demand — and a scan that throws is an
 * error, not an empty list.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-presets-'))
const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'test', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

let scans = 0
let failScan = false
const seenContexts: PresetContext[] = []

class Scanner extends BaseStrategy {
  readonly strategyId = 'scanner'
  override readonly monitors = []
  override readonly executors = []
  override readonly baseParamsSchema = z.object({
    market: z.string(),
    legs: z.object({ a: z.string(), b: z.string() }).meta({ picker: { source: 'strategy', id: 'pairs', ttlMs: 50 } }),
  })
  override readonly tunableParamsSchema = z.object({ size: z.number().default(1) })
  override readonly paramPresets: ParamPreset[] = [{ id: 'paper', label: 'Paper', tunable: { size: 0 } }]
  override readonly presetSource = { title: 'Opportunities', ttlMs: 50 }
  override async presets(ctx: PresetContext): Promise<ParamPreset[]> {
    scans += 1
    seenContexts.push(ctx)
    if (failScan) throw new Error('venue unreachable')
    return [{
      id: 'eth', label: 'ETH', base: { market: 'ETH' },
      card: { title: 'ETH', headline: { label: 'APR', value: '15.7%', tone: 'positive' }, badges: [{ text: 'executable' }] },
    }]
  }
  override async pickerOptions(pickerId: string, ctx: PresetContext): Promise<PickerOption[]> {
    scans += 1
    return [{ id: 'ab', label: `${pickerId}: A/B for ${String(ctx.params.base['market'] ?? '?')}`, value: { a: 'A', b: 'B' }, card: { title: 'A ↔ B' } }]
  }
  override async illustrationData(ctx: PresetContext): Promise<Record<string, unknown>> {
    scans += 1
    return { market: ctx.params.base['market'], size: ctx.params.tunable['size'] }
  }
  triggers(): Omit<Trigger, 'id' | 'strategyInstanceId'>[] { return [] }
  async evaluate(_ctx: StrategyContext): Promise<ExecutionInstruction[]> { return [] }
}

class Plain extends BaseStrategy {
  readonly strategyId = 'plain'
  override readonly monitors = []
  override readonly executors = []
  override readonly baseParamsSchema = z.object({})
  override readonly paramPresets: ParamPreset[] = [{ id: 'a', label: 'A' }]
  triggers(): Omit<Trigger, 'id' | 'strategyInstanceId'>[] { return [] }
  async evaluate(_ctx: StrategyContext): Promise<ExecutionInstruction[]> { return [] }
}

async function harness() {
  const database = new SQLiteAdapter({ filePath: path.join(tmpDir, `${Math.random().toString(36).slice(2)}.db`) })
  await database.initialize()
  const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, database, queue: new MemoryExecutionQueue() })
  const now = new Date().toISOString()
  runtime.registerStrategy({ id: 'scanner', name: 'Scanner', source: 'builtin', createdAt: now, updatedAt: now }, () => new Scanner())
  runtime.registerStrategy({ id: 'plain', name: 'Plain', source: 'builtin', createdAt: now, updatedAt: now }, () => new Plain())
  await runtime.start()
  return runtime
}

describe('live presets', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('a strategy with presets() is marked as a source; one without is not', async () => {
    const runtime = await harness()
    expect(runtime.listStrategies().find(s => s.id === 'scanner')!.presetSource).toEqual({ title: 'Opportunities', ttlMs: 50 })
    expect(runtime.listStrategies().find(s => s.id === 'plain')!.presetSource).toBeUndefined()
    // A plain strategy answers with its static list and no scan.
    expect((await runtime.strategyPresets('plain')).presets.map(p => p.id)).toEqual(['a'])
    await runtime.stop()
  })

  it('lists the static presets first, then the computed cards, and hands the form state to the scan', async () => {
    scans = 0
    const runtime = await harness()
    const out = await runtime.strategyPresets('scanner', { accounts: { main: 'CrossEx' }, params: { base: { market: 'BTC' } } })
    expect(out.presets.map(p => p.id)).toEqual(['paper', 'eth'])
    expect(out.presets[1]!.card?.headline?.value).toBe('15.7%')
    expect(out.source).toEqual({ title: 'Opportunities', ttlMs: 50 })
    expect(seenContexts.at(-1)!.accounts).toEqual({ main: 'CrossEx' })
    expect(seenContexts.at(-1)!.params).toEqual({ base: { market: 'BTC' }, tunable: {} })
    expect(scans).toBe(1)
    await runtime.stop()
  })

  it('caches by what the form sent, expires on the ttl, and refresh skips the cache', async () => {
    scans = 0
    const runtime = await harness()
    await runtime.strategyPresets('scanner', { accounts: { main: 'A' } })
    await runtime.strategyPresets('scanner', { accounts: { main: 'A' } })
    expect(scans).toBe(1)
    await runtime.strategyPresets('scanner', { accounts: { main: 'B' } })
    expect(scans).toBe(2)
    await runtime.strategyPresets('scanner', { accounts: { main: 'A' }, refresh: true })
    expect(scans).toBe(3)
    await new Promise(r => setTimeout(r, 60))
    await runtime.strategyPresets('scanner', { accounts: { main: 'A' } })
    expect(scans).toBe(4)
    await runtime.stop()
  })

  it('illustration data is computed for the form state, flagged on the definition, and refused where absent', async () => {
    scans = 0
    const runtime = await harness()
    expect(runtime.listStrategies().find(s => s.id === 'scanner')!.illustrationData).toBe(true)
    expect(runtime.listStrategies().find(s => s.id === 'plain')!.illustrationData).toBeUndefined()
    const a = await runtime.strategyIllustrationData('scanner', { params: { base: { market: 'ETH' }, tunable: { size: 2 } } })
    expect(a.data).toEqual({ market: 'ETH', size: 2 })
    await runtime.strategyIllustrationData('scanner', { params: { base: { market: 'ETH' }, tunable: { size: 2 } } })
    expect(scans).toBe(1)   // same state, served from the cache
    await expect(runtime.strategyIllustrationData('plain')).rejects.toThrow(/serves no illustration data/)
    await runtime.stop()
  })

  it('a picker field is derived with its picker, and its options come from the strategy, cached', async () => {
    scans = 0
    const runtime = await harness()
    const legs = runtime.listStrategies().find(s => s.id === 'scanner')!.paramsFields!.find(f => f.name === 'legs')!
    expect(legs.type).toBe('object')
    expect(legs.picker).toEqual({ source: 'strategy', id: 'pairs', ttlMs: 50 })
    const out = await runtime.strategyPickerOptions('scanner', 'pairs', { params: { base: { market: 'ETH' } } })
    expect(out.options).toEqual([{ id: 'ab', label: 'pairs: A/B for ETH', value: { a: 'A', b: 'B' }, card: { title: 'A ↔ B' } }])
    await runtime.strategyPickerOptions('scanner', 'pairs', { params: { base: { market: 'ETH' } } })
    expect(scans).toBe(1)
    await expect(runtime.strategyPickerOptions('scanner', 'nope')).rejects.toThrow(/declares no picker/)
    await expect(runtime.strategyPickerOptions('plain', 'pairs')).rejects.toThrow(/declares no picker/)
    await runtime.stop()
  })

  it('a scan that throws is an error, not an empty list', async () => {
    failScan = true
    const runtime = await harness()
    await expect(runtime.strategyPresets('scanner', { refresh: true })).rejects.toThrow(/venue unreachable/)
    failScan = false
    await runtime.stop()
  })
})
