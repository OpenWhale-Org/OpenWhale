import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { BaseStrategy } from '../BaseStrategy.js'
import { Strategy, Monitor, Executor, Account, Kind, VenueType } from '../decorators.js'
import type { StrategyContext } from '../../types/strategy.js'
import type { ExecutionInstruction } from '../../types/executor.js'

class FakeReader {
  static readonly kind = 'test/fake' as const
  constructor(readonly name: string) {}
}

class OtherReader {
  static readonly kind = 'test/other' as const
  constructor(readonly name: string) {}
}

@Strategy('decorated')
@Monitor('trades', 'user-trades')
@Executor('perp', 'exchange/perp-trading')
@Account('main', FakeReader)
@Account('hedge', OtherReader)
class DecoratedStrategy extends BaseStrategy {
  readonly baseParamsSchema = z.object({})
  readonly tunableParamsSchema = z.object({})
  async evaluate(_context: StrategyContext): Promise<ExecutionInstruction[]> { return [] }
}

describe('declaration decorators', () => {
  it('populates strategyId/monitors/executors/accounts on instantiation', () => {
    const s = new DecoratedStrategy()
    expect(s.strategyId).toBe('decorated')
    expect(s.monitors).toEqual([{ name: 'user-trades', label: 'trades' }])
    expect(s.executors).toEqual([{ name: 'exchange/perp-trading', label: 'perp' }])
    expect(s.accounts).toEqual([
      { account: FakeReader, label: 'main' },
      { account: OtherReader, label: 'hedge' },
    ])
  })

  it('preserves source order for repeated decorators (positional binding depends on it)', () => {
    const s = new DecoratedStrategy()
    expect(s.accounts.map(a => a.label)).toEqual(['main', 'hedge'])
  })

  it('resolves labels through the usual helpers', () => {
    const s = new DecoratedStrategy()
    expect(s.monitor('trades')).toBe('trades')
    expect(s.executor('perp')).toBe('perp')
    expect(() => s.monitor('nope' as never)).toThrow(/not declared/)
  })

  it('name defaults to the label when omitted', () => {
    @Monitor('ticker')
    class M extends BaseStrategy {
      readonly strategyId = 'm'
      readonly baseParamsSchema = z.object({})
      readonly tunableParamsSchema = z.object({})
      async evaluate(): Promise<ExecutionInstruction[]> { return [] }
    }
    expect(new M().monitors).toEqual([{ name: 'ticker', label: 'ticker' }])
  })

  it('merges along the inheritance chain — base slots first, most-derived id wins', () => {
    @Strategy('base')
    @Account('base', FakeReader)
    class Base extends BaseStrategy {
      readonly baseParamsSchema = z.object({})
      readonly tunableParamsSchema = z.object({})
      async evaluate(): Promise<ExecutionInstruction[]> { return [] }
    }
    @Strategy('sub')
    @Account('extra', OtherReader)
    class Sub extends Base {}

    expect(new Sub().strategyId).toBe('sub')
    expect(new Sub().accounts.map(a => a.label)).toEqual(['base', 'extra'])
    // The base class alone is unaffected by the subclass's decorators
    expect(new Base().strategyId).toBe('base')
    expect(new Base().accounts.map(a => a.label)).toEqual(['base'])
  })

  it('explicit field declarations override decorator metadata', () => {
    @Strategy('fromDecorator')
    @Account('fromDecorator', FakeReader)
    class Mixed extends BaseStrategy {
      override readonly strategyId = 'fromField'
      override readonly accounts = [{ account: OtherReader, label: 'fromField' }] as const
      readonly baseParamsSchema = z.object({})
      readonly tunableParamsSchema = z.object({})
      async evaluate(): Promise<ExecutionInstruction[]> { return [] }
    }
    const s = new Mixed()
    expect(s.strategyId).toBe('fromField')
    expect(s.accounts.map(a => a.label)).toEqual(['fromField'])
  })

  it('@Kind/@VenueType set the Reader statics the framework matches on', () => {
    @Kind('test/decorated')
    class DecoratedReader {
      constructor(readonly name: string) {}
    }
    @VenueType('venue-a')
    class VenueReader extends DecoratedReader {}

    expect((DecoratedReader as { kind?: string }).kind).toBe('test/decorated')
    expect((DecoratedReader as { venueType?: string }).venueType).toBeUndefined()
    // venue subclass inherits kind through the static prototype chain
    expect((VenueReader as { kind?: string }).kind).toBe('test/decorated')
    expect((VenueReader as { venueType?: string }).venueType).toBe('venue-a')

    // usable directly in an @Account slot
    @Strategy('with-decorated-reader')
    @Account('main', DecoratedReader)
    class S extends BaseStrategy {
      readonly baseParamsSchema = z.object({})
      readonly tunableParamsSchema = z.object({})
      async evaluate(): Promise<ExecutionInstruction[]> { return [] }
    }
    expect(new S().accounts[0]?.account.kind).toBe('test/decorated')
  })

  it('undecorated strategies keep their default empty declarations', () => {
    class Plain extends BaseStrategy {
      readonly strategyId = 'plain'
      readonly baseParamsSchema = z.object({})
      readonly tunableParamsSchema = z.object({})
      async evaluate(): Promise<ExecutionInstruction[]> { return [] }
    }
    expect(new Plain().monitors).toEqual([])
    expect(new Plain().accounts).toEqual([])
  })
})
