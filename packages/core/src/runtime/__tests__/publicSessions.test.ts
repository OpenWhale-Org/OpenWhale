import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import type { CredentialStore } from '../../types/credential.js'
import type { PluginFactory } from '../../plugin/PluginManager.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-public-sessions-'))

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'test', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

interface FakeSession { venue: string; closed: boolean; close(): Promise<void> }

function venuePlugin(name: string, created: FakeSession[]): PluginFactory<Record<string, never>> {
  return () => ({
    name,
    version: '1.0.0',
    monitors: [], executors: [], strategies: [],
    publicSessions: [{
      kind: 'test/data',
      create: () => {
        const session: FakeSession = { venue: name, closed: false, close: async () => { session.closed = true } }
        created.push(session)
        return session
      },
    }],
  })
}

describe('public session registry', () => {
  it('registers factories, lists venues, caches sessions, closes on unload', async () => {
    const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore })
    const createdA: FakeSession[] = []
    const createdB: FakeSession[] = []
    runtime.loadPlugin(venuePlugin('venue-a', createdA), {})
    runtime.loadPlugin(venuePlugin('venue-b', createdB), {})

    expect(runtime.publicSessions.venues('test/data').sort()).toEqual(['venue-a', 'venue-b'])
    expect(runtime.publicSessions.venues('test/other')).toEqual([])

    // Lazily created, then cached — the factory runs exactly once
    const first = await runtime.publicSessions.get<FakeSession>('venue-a', 'test/data')
    const second = await runtime.publicSessions.get<FakeSession>('venue-a', 'test/data')
    expect(first).toBe(second)
    expect(createdA).toHaveLength(1)
    expect(createdB).toHaveLength(0)

    await expect(runtime.publicSessions.get('nope', 'test/data')).rejects.toThrow(/No adapter registered/)

    // Unload closes that venue's cached sessions and removes its factories
    runtime.unloadPlugin('venue-a')
    expect(createdA[0]?.closed).toBe(true)
    expect(runtime.publicSessions.venues('test/data')).toEqual(['venue-b'])
    await expect(runtime.publicSessions.get('venue-a', 'test/data')).rejects.toThrow(/No adapter registered/)
  })

  it('rejects non-namespaced public session kinds', () => {
    const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore })
    const bad: PluginFactory<Record<string, never>> = () => ({
      name: 'bad', version: '1.0.0', monitors: [], executors: [], strategies: [],
      publicSessions: [{ kind: 'data' as never, create: () => ({}) }],
    })
    expect(() => runtime.loadPlugin(bad, {})).toThrow(/must be namespaced/)
  })
})
