import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BundleStore } from '../BundleStore.js'
import type { StrategyBundle } from '../../types/bundle.js'

function makeBundle(id: string): StrategyBundle {
  return {
    id,
    name: `Bundle ${id}`,
    strategyId: `strategy-${id}`,
    triggers: [],
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('BundleStore', () => {
  let tmpDir: string
  let store: BundleStore

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'openwhale-test-'))
    store = new BundleStore(tmpDir)
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  it('saves and loads a bundle', async () => {
    const bundle = makeBundle('b1')
    await store.save(bundle)
    const loaded = await store.load('b1')
    expect(loaded).toEqual(bundle)
  })

  it('returns null for a missing bundle', async () => {
    const result = await store.load('nonexistent')
    expect(result).toBeNull()
  })

  it('loadAll returns empty array when bundles dir does not exist', async () => {
    const result = await store.loadAll()
    expect(result).toEqual([])
  })

  it('loadAll returns all saved bundles', async () => {
    await store.save(makeBundle('b1'))
    await store.save(makeBundle('b2'))
    const all = await store.loadAll()
    expect(all).toHaveLength(2)
    expect(all.map((b) => b.id).sort()).toEqual(['b1', 'b2'])
  })

  it('delete removes a bundle', async () => {
    await store.save(makeBundle('b1'))
    await store.delete('b1')
    const result = await store.load('b1')
    expect(result).toBeNull()
  })

  it('delete is a no-op for nonexistent bundle', async () => {
    await expect(store.delete('nonexistent')).resolves.not.toThrow()
  })

  it('loadAll excludes deleted bundles', async () => {
    await store.save(makeBundle('b1'))
    await store.save(makeBundle('b2'))
    await store.delete('b1')
    const all = await store.loadAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe('b2')
  })

  it('save overwrites an existing bundle', async () => {
    const bundle = makeBundle('b1')
    await store.save(bundle)
    const updated = { ...bundle, name: 'Updated' }
    await store.save(updated)
    const loaded = await store.load('b1')
    expect(loaded?.name).toBe('Updated')
  })
})
