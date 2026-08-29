import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import { BaseStrategy } from '../../strategy/BaseStrategy.js'
import type { AvailabilityChecker, CredentialStore, ExecutionInstruction, StrategyContext, Trigger } from '../../index.js'

/** The check never reads a credential — markets come from the KEYLESS cell. */
const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => { throw new Error('not used') },
  delete: async () => undefined,
  list: async () => [],
}

/**
 * Param availability: "does the venue I am about to bind actually support what
 * I picked?" — the built-in market check and a strategy-provided checker.
 */

const MARKETS = [
  { symbol: 'AAA/USDT:USDT', type: 'swap' },
  { symbol: 'BBB/USDT:USDT', type: 'swap' },
  { symbol: 'THIN/USDT:USDT', type: 'swap' },
]

class PickerStrategy extends BaseStrategy {
  readonly strategyId = 'picker'
  override readonly monitors = []
  override readonly executors = []
  override readonly accounts = []

  override readonly baseParamsSchema = z.object({
    // Composite values: one entry names two symbols
    pairs: z.string().default('').meta({
      displayName: 'Pairs',
      multiple: true,
      availability: { source: 'market' as const, separator: '|' },
    }),
    // Custom logic the built-in cannot express
    picky: z.string().default('').meta({
      displayName: 'Picky',
      availability: { checker: 'liquidity' },
    }),
    plain: z.string().default('').meta({ displayName: 'No check' }),
    // A second venue's symbol: the form resolves the venue from THAT slot
    other: z.string().default('').meta({
      displayName: 'Other',
      catalogue: { source: 'market' as const, accountSlot: 'short' },
      availability: { source: 'market' as const, accountSlot: 'short' },
    }),
  })

  override readonly availabilityCheckers: Record<string, AvailabilityChecker> = {
    liquidity: (values, ctx) => values.map(value => {
      const listed = ctx.markets.some(m => m['symbol'] === value)
      if (!listed) return { value, available: false, reason: 'not listed' }
      if (value.startsWith('THIN')) return { value, available: true, reason: 'thin book — observation only' }
      return { value, available: true }
    }),
  }

  triggers(): Omit<Trigger, 'id' | 'strategyInstanceId'>[] { return [] }
  async evaluate(_c: StrategyContext): Promise<ExecutionInstruction[]> { return [] }
}

describe('checkParamAvailability', () => {
  let runtime: OpenWhaleRuntime

  beforeEach(() => {
    runtime = new OpenWhaleRuntime({ credentialStore })
    runtime.registerStrategy(
      { id: 'picker', name: 'Picker', source: 'plugin', createdAt: '', updatedAt: '' },
      () => new PickerStrategy(),
    )
    runtime.loadPlugin(() => ({
      name: 'fakes', version: '0.0.0',
      adapters: [
        { kind: 'exchange/perp' as never, type: 'fake', create: () => ({ fetchMarkets: async () => MARKETS }) as never },
        // A venue that lists nothing — the check must stay silent, not fail everything
        { kind: 'exchange/perp' as never, type: 'mute', create: () => ({}) as never },
      ],
    }), {})
  })

  it('passes values whose every symbol is listed', async () => {
    const verdicts = await runtime.checkParamAvailability('picker', 'pairs', ['AAA/USDT:USDT|BBB/USDT:USDT'], 'fake')
    expect(verdicts).toEqual([{ value: 'AAA/USDT:USDT|BBB/USDT:USDT', available: true }])
  })

  it('names the missing half of a composite value', async () => {
    const [verdict] = await runtime.checkParamAvailability('picker', 'pairs', ['AAA/USDT:USDT|NOPE/USDT:USDT'], 'fake')
    expect(verdict!.available).toBe(false)
    expect(verdict!.reason).toContain('NOPE/USDT:USDT')
    expect(verdict!.reason).not.toContain('AAA')   // only what is actually missing
  })

  it('judges each value independently', async () => {
    const verdicts = await runtime.checkParamAvailability('picker', 'pairs',
      ['AAA/USDT:USDT', 'GHOST/USDT:USDT'], 'fake')
    expect(verdicts.map(v => v.available)).toEqual([true, false])
  })

  it('uses a strategy-provided checker when one is named', async () => {
    const verdicts = await runtime.checkParamAvailability('picker', 'picky',
      ['AAA/USDT:USDT', 'THIN/USDT:USDT', 'GHOST/USDT:USDT'], 'fake')
    expect(verdicts).toEqual([
      { value: 'AAA/USDT:USDT', available: true },
      // available WITH a reason — a warning, not a rejection
      { value: 'THIN/USDT:USDT', available: true, reason: 'thin book — observation only' },
      { value: 'GHOST/USDT:USDT', available: false, reason: 'not listed' },
    ])
  })

  it('stays silent when the venue publishes no catalogue', async () => {
    expect(await runtime.checkParamAvailability('picker', 'pairs', ['AAA/USDT:USDT'], 'mute')).toEqual([])
  })

  it('rejects a field that declares no check, and an unknown venue', async () => {
    await expect(runtime.checkParamAvailability('picker', 'plain', ['x'], 'fake')).rejects.toThrow(/no availability check/)
    await expect(runtime.checkParamAvailability('picker', 'pairs', ['x'], 'nowhere')).rejects.toThrow(/No "exchange\/perp" adapter/)
  })

  it('carries accountSlot through to the field definition for the form to resolve', () => {
    const field = new PickerStrategy().paramsFields?.find(f => f.name === 'other')
    expect(field?.catalogue?.accountSlot).toBe('short')
    expect(field?.availability?.accountSlot).toBe('short')
  })

  it('short-circuits an empty selection', async () => {
    expect(await runtime.checkParamAvailability('picker', 'pairs', [], 'fake')).toEqual([])
  })
})
