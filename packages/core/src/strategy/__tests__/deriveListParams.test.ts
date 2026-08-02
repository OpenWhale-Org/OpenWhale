import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { BaseStrategy } from '../BaseStrategy.js'

/**
 * Array-of-objects params derive as `list` fields: the element shape becomes
 * the columns, each column's .meta() its display info. This is what lets a
 * ladder ("at level X do Y") render as an editable row table with sliders
 * instead of a CSV string.
 */
describe('deriveParamFields — list params', () => {
  const tunable = z.object({
    entryLadder: z.array(z.object({
      sigma: z.number().min(0).meta({ displayName: '|z| ≥', unit: 'σ', slider: { min: 0, max: 5, step: 0.05 } }),
      cumPct: z.number().min(0).max(100).meta({ displayName: 'Cumulative %', unit: '%', slider: { min: 0, max: 100, step: 5 } }),
    })).default([
      { sigma: 1, cumPct: 10 },
      { sigma: 1.5, cumPct: 30 },
    ]).meta({ displayName: 'Entry ladder', list: { addLabel: 'Add rung' } }),
    plain: z.number().default(3).meta({ displayName: 'Plain', slider: { min: 0, max: 10 } }),
  })

  const fields = BaseStrategy.deriveParamFields(z.object({}), tunable)!

  it('derives type list with columns from the element shape', () => {
    const f = fields.find(x => x.name === 'entryLadder')!
    expect(f.type).toBe('list')
    expect(f.list?.columns.map(c => c.name)).toEqual(['sigma', 'cumPct'])
    expect(f.list?.columns[0]).toMatchObject({
      displayName: '|z| ≥', type: 'number', unit: 'σ', slider: { min: 0, max: 5, step: 0.05 },
    })
    expect(f.list?.addLabel).toBe('Add rung')
  })

  it('carries the row-array default through', () => {
    const f = fields.find(x => x.name === 'entryLadder')!
    expect(f.default).toEqual([{ sigma: 1, cumPct: 10 }, { sigma: 1.5, cumPct: 30 }])
  })

  it('sliders also attach to plain number fields', () => {
    const f = fields.find(x => x.name === 'plain')!
    expect(f.type).toBe('number')
    expect(f.slider).toEqual({ min: 0, max: 10 })
  })

  it('an array without an object element degrades to a plain list with no columns', () => {
    const derived = BaseStrategy.deriveParamFields(
      z.object({}),
      z.object({ xs: z.array(z.number()).default([]) }),
    )!
    const f = derived.find(x => x.name === 'xs')!
    expect(f.type).toBe('list')
    expect(f.list).toBeUndefined()
  })
})
