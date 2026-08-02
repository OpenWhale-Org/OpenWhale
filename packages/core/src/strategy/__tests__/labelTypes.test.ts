import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { BaseStrategy } from '../BaseStrategy.js'
import type { StrategyDeclarations } from '../BaseStrategy.js'
import type { StrategyContext } from '../../types/strategy.js'
import type { ExecutionInstruction } from '../../types/executor.js'

/**
 * Compile-time coverage for label autocomplete/checking: with a
 * `satisfies StrategyDeclarations` declaration object passed as the class
 * type argument, monitor()/executor()/account()/instruction() only accept
 * the declared labels. The @ts-expect-error lines ARE the assertions — tsc
 * fails the build if a typo'd label stops being an error.
 */

class FakeReader {
  static readonly kind = 'test/fake' as const
  positions(): string[] { return [] }
}

const decls = {
  monitors: [{ name: 'user-trades', label: 'trades' }, 'ticker'],
  executors: [{ name: 'perp-trading', label: 'perp' }],
  accounts: [{ account: FakeReader, label: 'main' }],
} as const satisfies StrategyDeclarations

class TypedStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'typed'
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts
  override readonly baseParamsSchema = z.object({})

  async evaluate(_context: StrategyContext): Promise<ExecutionInstruction[]> {
    // Declared labels — must compile
    this.monitor('trades')
    this.monitor('ticker')      // string shorthand: name === label
    this.monitor(0)             // index access stays allowed
    this.executor('perp')
    this.monitorData('trades')

    // @ts-expect-error unknown monitor label must be rejected
    this.monitor('tradez')
    // @ts-expect-error unknown executor label must be rejected
    this.executor('spot')
    // @ts-expect-error unknown account label must be rejected in instruction()
    this.instruction('perp', 'noop', {}, ['maim'])

    return [this.instruction('perp', 'noop', {}, ['main'])]
  }
}

/**
 * Readers are typed from the declaration's class reference; strategies hold
 * ONLY Readers — there is no declaration form that yields a session, so write
 * access is structurally unreachable (no @ts-expect-error needed: the API
 * surface simply doesn't exist).
 */
class ReaderTypedStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'reader-typed'
  override readonly accounts = decls.accounts

  async evaluate(_context: StrategyContext): Promise<ExecutionInstruction[]> {
    const reader = this.account('main')      // FakeReader — typed from the class ref
    void reader.positions()
    // @ts-expect-error methods not on the Reader class do not exist
    void reader.createOrder
    return []
  }
}
void ReaderTypedStrategy

/** Without `as const`, labels fall back to plain string — no breakage for loose declarations. */
class LooseStrategy extends BaseStrategy {
  readonly strategyId = 'loose'
  override readonly monitors: readonly string[] = ['anything']
  async evaluate(): Promise<ExecutionInstruction[]> {
    this.monitor('whatever-string')  // must compile
    return []
  }
}

describe('declaration label typing', () => {
  it('resolves declared labels at runtime', () => {
    const s = new TypedStrategy()
    expect(s.monitor('trades')).toBe('trades')
    expect(s.monitor('ticker')).toBe('ticker')
    expect(s.monitor(0)).toBe('trades')
    expect(s.executor('perp')).toBe('perp')
    expect(() => s.monitor('nope' as never)).toThrow(/not declared/)
    expect(new LooseStrategy().monitor('anything')).toBe('anything')
  })
})
