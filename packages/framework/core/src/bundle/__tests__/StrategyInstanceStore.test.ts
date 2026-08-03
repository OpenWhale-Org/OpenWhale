import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { StrategyInstanceStore } from '../StrategyInstanceStore.js'
import type { StrategyInstance } from '../../types/instance.js'

function makeInstance(id: string): StrategyInstance {
  return {
    id,
    name: `Instance ${id}`,
    strategyId: `strategy-${id}`,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('StrategyInstanceStore', () => {
  let tmpDir: string
  let store: StrategyInstanceStore

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openwhale-test-'))
    store = new StrategyInstanceStore(tmpDir)
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('saves and loads an instance', async () => {
    const instance = makeInstance('i1')
    await store.save(instance)
    const loaded = await store.load('i1')
    expect(loaded).toEqual(instance)
  })

  it('returns null for a missing instance', async () => {
    const result = await store.load('nonexistent')
    expect(result).toBeNull()
  })

  it('loadAll returns empty array when instances dir does not exist', async () => {
    const result = await store.loadAll()
    expect(result).toEqual([])
  })

  it('loadAll returns all saved instances', async () => {
    await store.save(makeInstance('i1'))
    await store.save(makeInstance('i2'))
    const all = await store.loadAll()
    expect(all).toHaveLength(2)
    expect(all.map((b) => b.id).sort()).toEqual(['i1', 'i2'])
  })

  it('delete removes an instance', async () => {
    await store.save(makeInstance('i1'))
    await store.delete('i1')
    const result = await store.load('i1')
    expect(result).toBeNull()
  })

  it('delete is a no-op for nonexistent instance', async () => {
    await expect(store.delete('nonexistent')).resolves.not.toThrow()
  })

  it('loadAll excludes deleted instances', async () => {
    await store.save(makeInstance('i1'))
    await store.save(makeInstance('i2'))
    await store.delete('i1')
    const all = await store.loadAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe('i2')
  })

  it('save overwrites an existing instance', async () => {
    const instance = makeInstance('i1')
    await store.save(instance)
    const updated = { ...instance, name: 'Updated' }
    await store.save(updated)
    const loaded = await store.load('i1')
    expect(loaded?.name).toBe('Updated')
  })
})
