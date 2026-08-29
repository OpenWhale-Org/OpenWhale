import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import { BaseStrategy } from '../../strategy/BaseStrategy.js'
import type { CredentialStore, ExecutionInstruction, ParamPreset, StrategyContext, Trigger } from '../../index.js'

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => { throw new Error('not used') },
  delete: async () => undefined,
  list: async () => [],
}

/**
 * Strategy-declared parameter presets reach the registered definition — what
 * the gateway serves and the instance form reads — exactly as declared.
 */

const PRESETS: ParamPreset[] = [
  { id: 'paper', label: 'Paper', description: 'tiny size', base: { symbol: 'BTC/USDT:USDT' }, tunable: { size: 0.001 } },
  { id: 'aggressive', label: 'Aggressive', tunable: { size: 1, threshold: 0.5 } },
]

class PresetStrategy extends BaseStrategy {
  readonly strategyId = 'preset'
  override readonly monitors = []
  override readonly executors = []
  override readonly accounts = []
  override readonly baseParamsSchema = z.object({ symbol: z.string() })
  override readonly tunableParamsSchema = z.object({ size: z.number().default(0.01), threshold: z.number().default(1) })
  override readonly paramPresets = PRESETS
  triggers(): Omit<Trigger, 'id' | 'strategyInstanceId'>[] { return [] }
  async evaluate(_c: StrategyContext): Promise<ExecutionInstruction[]> { return [] }
}

class BareStrategy extends BaseStrategy {
  readonly strategyId = 'bare'
  override readonly monitors = []
  override readonly executors = []
  override readonly accounts = []
  triggers(): Omit<Trigger, 'id' | 'strategyInstanceId'>[] { return [] }
  async evaluate(_c: StrategyContext): Promise<ExecutionInstruction[]> { return [] }
}

describe('paramPresets', () => {
  it('surfaces the presets a strategy class declares on its definition', () => {
    const runtime = new OpenWhaleRuntime({ credentialStore })
    runtime.registerStrategy({ id: 'preset', name: 'Preset', source: 'plugin', createdAt: '', updatedAt: '' }, () => new PresetStrategy())
    const def = runtime.listStrategies().find(d => d.id === 'preset')
    expect(def?.paramPresets).toEqual(PRESETS)
  })

  it('omits the key when the strategy declares none', () => {
    const runtime = new OpenWhaleRuntime({ credentialStore })
    runtime.registerStrategy({ id: 'bare', name: 'Bare', source: 'plugin', createdAt: '', updatedAt: '' }, () => new BareStrategy())
    expect(runtime.listStrategies().find(d => d.id === 'bare')).not.toHaveProperty('paramPresets')
  })

  it('lets a definition passed in explicitly win over the class', () => {
    const runtime = new OpenWhaleRuntime({ credentialStore })
    const explicit: ParamPreset[] = [{ id: 'only', label: 'Only' }]
    runtime.registerStrategy({ id: 'preset', name: 'Preset', source: 'plugin', createdAt: '', updatedAt: '', paramPresets: explicit }, () => new PresetStrategy())
    expect(runtime.listStrategies().find(d => d.id === 'preset')?.paramPresets).toEqual(explicit)
  })
})
