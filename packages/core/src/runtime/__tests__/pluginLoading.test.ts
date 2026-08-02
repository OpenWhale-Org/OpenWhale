import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import type { CredentialStore } from '../../types/credential.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-plugin-test-'))

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'test', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

/**
 * A minimal plugin module written to disk and loaded via dynamic import.
 * Components are duck-typed: the runtime never instanceof-checks them.
 */
const PLUGIN_SOURCE = `
class FakeMonitor {
  get monitorName() { return 'ticker' }
  addEmitHandler() {}
  removeEmitHandler() {}
  subscribe() {}
  unsubscribe() {}
  subscribeAll() {}
  unsubscribeAll() {}
  getReader() { return null }
  mode = 'subscribe'
}
class FakeExecutor {
  get executorName() { return 'trade' }
  get supportedActions() { return ['noop'] }
  get accountTypes() { return [] }
  setAccounts() {}
  removeAccounts() {}
  async run() {}
  async execute(i) { return { instruction: i, status: 'success', executedAt: new Date() } }
}
export default function testPlugin(ctx) {
  const now = new Date().toISOString()
  return {
    name: 'testplug',
    version: '1.2.3',
    monitors: [{ definition: { id: 'ticker', name: 'Ticker', source: 'plugin', pluginName: 'testplug', createdAt: now, updatedAt: now }, instance: new FakeMonitor() }],
    executors: [{ definition: { id: 'trade', name: 'Trade', source: 'plugin', pluginName: 'testplug', supportedActions: ['noop'], createdAt: now, updatedAt: now }, instance: new FakeExecutor() }],
    strategies: [],
    credentialTypes: [{ type: 'testplug', raw: true }],
  }
}
`

describe('runtime plugin loading', () => {
  let runtime: OpenWhaleRuntime
  let pluginPath: string

  beforeEach(() => {
    runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore })
    pluginPath = path.join(tmpDir, `plugin-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`)
    fs.writeFileSync(pluginPath, PLUGIN_SOURCE)
  })

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('loads a plugin from a module path with namespaced ids', async () => {
    const name = await runtime.loadPluginFromPath(pluginPath, { some: 'config' })
    expect(name).toBe('testplug')

    expect(runtime.listMonitors().map(m => m.id)).toContain('testplug/ticker')
    expect(runtime.listExecutors().map(e => e.id)).toContain('testplug/trade')

    const plugins = runtime.listLoadedPlugins()
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({
      name: 'testplug',
      version: '1.2.3',
      monitors: ['testplug/ticker'],
      executors: ['testplug/trade'],
      kinds: [],
      credentialTypes: ['testplug'],
    })
  })

  it('rejects loading the same plugin twice', async () => {
    await runtime.loadPluginFromPath(pluginPath, {})
    await expect(runtime.loadPluginFromPath(pluginPath, {})).rejects.toThrow(/already loaded/)
  })

  it('rejects a module without a default factory export', async () => {
    const badPath = path.join(tmpDir, 'bad.mjs')
    fs.writeFileSync(badPath, 'export const nothing = 1')
    await expect(runtime.loadPluginFromPath(badPath, {})).rejects.toThrow(/default-export/)
  })

  it('unloads a plugin and removes its registrations', async () => {
    await runtime.loadPluginFromPath(pluginPath, {})
    runtime.unloadPlugin('testplug')

    expect(runtime.listLoadedPlugins()).toHaveLength(0)
    expect(runtime.listMonitors().map(m => m.id)).not.toContain('testplug/ticker')
    expect(runtime.listExecutors().map(e => e.id)).not.toContain('testplug/trade')
    expect(() => runtime.unloadPlugin('testplug')).toThrow(/not loaded/)
  })
})
