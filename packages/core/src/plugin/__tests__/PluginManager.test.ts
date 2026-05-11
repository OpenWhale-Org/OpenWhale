import { describe, it, expect, beforeEach } from 'vitest'
import { PluginManager } from '../PluginManager.js'
import type { PluginFactory, OpenWhalePlugin } from '../PluginManager.js'
import { Registry } from '../../registry/Registry.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../../types/definition.js'
import type { BaseMonitor } from '../../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../../executor/BaseExecutor.js'
import type { IStrategy } from '../../types/strategy.js'
import type { CredentialStore } from '../../types/credential.js'

const mockCredentials = {} as CredentialStore

function makeMonitorDef(id: string): MonitorDefinition {
  return { id, name: id, source: 'plugin', pluginName: 'test-plugin', createdAt: '', updatedAt: '' }
}
function makeExecutorDef(id: string): ExecutorDefinition {
  return { id, name: id, source: 'plugin', pluginName: 'test-plugin', supportedActions: [], createdAt: '', updatedAt: '' }
}
function makeStrategyDef(id: string): StrategyDefinition {
  return { id, name: id, source: 'plugin', pluginName: 'test-plugin', monitorIds: [], executorIds: [], createdAt: '', updatedAt: '' }
}

function makePlugin(name: string): PluginFactory<Record<string, unknown>> {
  return () => ({
    name,
    version: '1.0.0',
    monitors: [{ definition: makeMonitorDef(`${name}-monitor`), instance: {} as BaseMonitor }],
    executors: [{ definition: makeExecutorDef(`${name}-executor`), instance: {} as BaseExecutor }],
    strategies: [{ definition: makeStrategyDef(`${name}-strategy`), factory: () => ({} as IStrategy) }],
    accounts: [],
  })
}

describe('PluginManager', () => {
  let monitorRegistry: Registry<MonitorDefinition, BaseMonitor>
  let executorRegistry: Registry<ExecutorDefinition, BaseExecutor>
  let strategyRegistry: Registry<StrategyDefinition, () => IStrategy>
  let manager: PluginManager

  beforeEach(() => {
    monitorRegistry = new Registry()
    executorRegistry = new Registry()
    strategyRegistry = new Registry()
    manager = new PluginManager({
      monitorRegistry,
      executorRegistry,
      strategyRegistry,
      credentials: mockCredentials,
    })
  })

  it('load registers all plugin components into registries', () => {
    manager.load(makePlugin('hyperliquid'), {})
    expect(monitorRegistry.getDefinition('hyperliquid-monitor')).toBeDefined()
    expect(executorRegistry.getDefinition('hyperliquid-executor')).toBeDefined()
    expect(strategyRegistry.getDefinition('hyperliquid-strategy')).toBeDefined()
  })

  it('unload removes all plugin components from registries', () => {
    manager.load(makePlugin('hyperliquid'), {})
    manager.unload('hyperliquid')
    expect(monitorRegistry.getDefinition('hyperliquid-monitor')).toBeUndefined()
    expect(executorRegistry.getDefinition('hyperliquid-executor')).toBeUndefined()
    expect(strategyRegistry.getDefinition('hyperliquid-strategy')).toBeUndefined()
  })

  it('unload of unknown plugin is a no-op', () => {
    expect(() => manager.unload('nonexistent')).not.toThrow()
  })

  it('loading same plugin twice replaces the previous registration', () => {
    manager.load(makePlugin('hyperliquid'), {})
    manager.load(makePlugin('hyperliquid'), {})
    expect(manager.listPlugins()).toHaveLength(1)
    expect(monitorRegistry.list()).toHaveLength(1)
  })

  it('listPlugins returns names of all loaded plugins', () => {
    manager.load(makePlugin('hyperliquid'), {})
    manager.load(makePlugin('uniswap'), {})
    expect(manager.listPlugins().sort()).toEqual(['hyperliquid', 'uniswap'])
  })

  it('passes typed config to plugin factory', () => {
    interface MyConfig { testnet: boolean }
    let receivedConfig: MyConfig | undefined
    const factory: PluginFactory<MyConfig> = (ctx) => {
      receivedConfig = ctx.config
      return { name: 'my-plugin', version: '1.0.0', monitors: [], executors: [], strategies: [], accounts: [] }
    }
    manager.load(factory, { testnet: true })
    expect(receivedConfig).toEqual({ testnet: true })
  })
})
