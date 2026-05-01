import { describe, it, expect, beforeEach } from 'vitest'
import { Registry } from '../Registry.js'

interface TestDef {
  id: string
  name: string
}

type TestInst = { value: number }

describe('Registry', () => {
  let registry: Registry<TestDef, TestInst>

  beforeEach(() => {
    registry = new Registry()
  })

  it('registers and retrieves an instance by id', () => {
    registry.register({ id: 'a', name: 'A' }, { value: 1 })
    expect(registry.get('a')).toEqual({ value: 1 })
  })

  it('retrieves a definition by id', () => {
    registry.register({ id: 'a', name: 'A' }, { value: 1 })
    expect(registry.getDefinition('a')).toEqual({ id: 'a', name: 'A' })
  })

  it('returns undefined for unknown id', () => {
    expect(registry.get('unknown')).toBeUndefined()
    expect(registry.getDefinition('unknown')).toBeUndefined()
  })

  it('lists all registered definitions', () => {
    registry.register({ id: 'a', name: 'A' }, { value: 1 })
    registry.register({ id: 'b', name: 'B' }, { value: 2 })
    const list = registry.list()
    expect(list).toHaveLength(2)
    expect(list.map((d) => d.id)).toContain('a')
    expect(list.map((d) => d.id)).toContain('b')
  })

  it('unregisters an entry', () => {
    registry.register({ id: 'a', name: 'A' }, { value: 1 })
    registry.unregister('a')
    expect(registry.get('a')).toBeUndefined()
    expect(registry.getDefinition('a')).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })

  it('unregistering a non-existent id is a no-op', () => {
    expect(() => registry.unregister('nonexistent')).not.toThrow()
  })

  it('overrides an existing entry when registering same id', () => {
    registry.register({ id: 'a', name: 'A' }, { value: 1 })
    registry.register({ id: 'a', name: 'A-updated' }, { value: 2 })
    expect(registry.get('a')).toEqual({ value: 2 })
    expect(registry.getDefinition('a')).toEqual({ id: 'a', name: 'A-updated' })
    expect(registry.list()).toHaveLength(1)
  })
})
