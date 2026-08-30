import { describe, it, expect } from 'vitest'
import type { ParamFieldDef } from '@openwhaleorg/core'
import { applyChanges, planImport, paramsJson, fieldValuesFromParams } from '../paramsIo'

/**
 * Import is the risky direction: it lands on an instance that is usually
 * running, from a file that is usually partial. These pin what it touches.
 */

const FIELDS: ParamFieldDef[] = [
  { name: 'symbolA', displayName: 'A leg', type: 'string', group: 'base' },
  { name: 'notional', displayName: 'Notional', type: 'number', group: 'base', default: 500 },
  { name: 'dryRun', displayName: 'Dry run', type: 'boolean', group: 'base', default: false },
  { name: 'entryZ', displayName: 'Entry z', type: 'number', group: 'tunable', default: 2 },
  { name: 'ladder', displayName: 'Ladder', type: 'list', group: 'tunable' },
]

const CURRENT = fieldValuesFromParams(FIELDS, {
  base: { symbolA: 'SNXX/USDT:USDT', notional: 500, dryRun: false },
  tunable: { entryZ: 2 },
})

function plan(text: string) {
  const result = planImport(FIELDS, CURRENT, text)
  if ('error' in result) throw new Error(result.error)
  return result
}

describe('planImport', () => {
  it('overwrites only the fields the file names, and leaves the rest alone', () => {
    const p = plan('{"tunable":{"entryZ":1.8}}')
    expect(p.changes.map(c => c.name)).toEqual(['entryZ'])
    expect(p.changes[0]).toMatchObject({ label: 'Entry z', group: 'tunable', from: '2', to: '1.8' })
    const applied = applyChanges(CURRENT, p.changes)
    expect(applied.entryZ).toBe('1.8')
    expect(applied.symbolA).toBe(CURRENT.symbolA)
    expect(applied.notional).toBe('500')
  })

  it('separates what changes, what already matches, and what this strategy has no field for', () => {
    const p = plan('{"base":{"notional":800,"symbolA":"SNXX/USDT:USDT"},"tunable":{"whoIsThis":1}}')
    expect(p.changes.map(c => c.name)).toEqual(['notional'])
    expect(p.unchanged).toEqual(['symbolA'])
    expect(p.unknown).toEqual(['whoIsThis'])
    expect(applyChanges(CURRENT, p.changes).whoIsThis).toBeUndefined()
  })

  it('takes a flat map and a whole instance record, not just the export shape', () => {
    expect(plan('{"entryZ":1.5}').changes.map(c => c.name)).toEqual(['entryZ'])
    expect(plan('{"id":"inst_1","params":{"tunable":{"entryZ":1.5}}}').changes.map(c => c.name)).toEqual(['entryZ'])
  })

  it('writes a list back as JSON so the list editor can read it', () => {
    const p = plan('{"tunable":{"ladder":[[1,0.5],[2,0.5]]}}')
    expect(applyChanges(CURRENT, p.changes).ladder).toBe('[[1,0.5],[2,0.5]]')
  })

  it('reports unreadable input instead of applying half of it', () => {
    expect(planImport(FIELDS, CURRENT, '{oops')).toHaveProperty('error')
    expect(planImport(FIELDS, CURRENT, '[1,2]')).toHaveProperty('error')
  })
})

describe('applyChanges', () => {
  it('takes only the rows kept — a struck-off field holds its current value', () => {
    const p = plan('{"base":{"notional":800},"tunable":{"entryZ":1.8}}')
    const kept = p.changes.filter(c => c.name !== 'notional')
    const applied = applyChanges(CURRENT, kept)
    expect(applied.entryZ).toBe('1.8')
    expect(applied.notional).toBe('500')
  })
})

describe('paramsJson', () => {
  it('is what Save would send — typed by field, not the raw strings', () => {
    const doc = JSON.parse(paramsJson(FIELDS, { ...CURRENT, dryRun: 'true', ladder: '[[1,1]]' }))
    expect(doc).toEqual({
      base: { symbolA: 'SNXX/USDT:USDT', notional: 500, dryRun: true },
      tunable: { entryZ: 2, ladder: [[1, 1]] },
    })
  })

  it('round-trips through import with nothing to change', () => {
    const p = plan(paramsJson(FIELDS, CURRENT))
    expect(p.changes).toEqual([])
  })
})
