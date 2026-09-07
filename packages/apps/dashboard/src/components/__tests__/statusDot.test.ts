import { describe, it, expect } from 'vitest'
import { statusDot, statusTitle } from '../../app/instances/status'
import type { StrategyInstanceView } from '@openwhaleorg/core'

/**
 * A dry-running instance looks exactly as busy as a live one — same runs, same
 * signals, same log — while the engine queues none of its instructions. Green
 * for that would be the dashboard agreeing with the mistake.
 */
const inst = (over: Partial<StrategyInstanceView>): StrategyInstanceView => ({
  id: 'i1', name: 'x', strategyId: 's', params: { base: {}, tunable: {} }, active: false, ...over,
} as StrategyInstanceView)

describe('the status dot', () => {
  it('is green only when the instance is both running and trading', () => {
    expect(statusDot(inst({ active: true }))).toBe('var(--success)')
    expect(statusTitle(inst({ active: true }))).toBe('Running')
  })

  it('is amber while dry run holds the instructions', () => {
    const dry = inst({ active: true, options: { dryRun: true } })
    expect(statusDot(dry)).toBe('var(--warning)')
    expect(statusTitle(dry)).toContain('dry run')
  })

  it('says stopped when it is stopped, dry run or not', () => {
    expect(statusDot(inst({ active: false, options: { dryRun: true } }))).toBe('var(--border)')
    expect(statusTitle(inst({ active: false, options: { dryRun: true } }))).toBe('Stopped')
  })

  it('lets a broken instance outrank both — its strategy is gone', () => {
    const broken = inst({ active: true, options: { dryRun: true }, problem: 'strategy not registered' })
    expect(statusDot(broken)).toBe('var(--danger)')
    expect(statusTitle(broken)).toBe('strategy not registered')
  })
})
