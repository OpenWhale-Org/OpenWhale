import type { CredentialStore } from '../types/credential.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { IStrategy } from '../types/strategy.js'
import type { AccountFactory } from '../types/account.js'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../types/definition.js'

export interface OpenWhalePlugin {
  name: string
  version: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitors: Array<{ definition: MonitorDefinition; instance: BaseMonitor<string, any> }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executors: Array<{ definition: ExecutorDefinition; instance: BaseExecutor<any> }>
  /** Strategy factories — each activate() call creates a fresh instance. */
  strategies: Array<{ definition: StrategyDefinition; factory: () => IStrategy }>
  /** Account factories — registered by accountType. */
  accounts: Array<{ accountType: string; factory: AccountFactory }>
}

export interface PluginContext<TConfig = Record<string, unknown>> {
  credentials: CredentialStore
  config: TConfig
}

export type PluginFactory<TConfig = Record<string, unknown>> = (
  context: PluginContext<TConfig>
) => OpenWhalePlugin

export interface PluginManagerOptions {
  monitorRegistry: MonitorRegistry
  executorRegistry: ExecutorRegistry
  strategyRegistry: StrategyRegistry
  credentials: CredentialStore
  /** Callback to register account factories with the runtime. */
  registerAccountFactory?: (accountType: string, factory: AccountFactory) => void
}

export class PluginManager {
  private readonly monitorRegistry: MonitorRegistry
  private readonly executorRegistry: ExecutorRegistry
  private readonly strategyRegistry: StrategyRegistry
  private readonly credentials: CredentialStore
  private readonly registerAccountFactory: ((accountType: string, factory: AccountFactory) => void) | undefined
  private readonly loadedPlugins = new Map<string, OpenWhalePlugin>()

  constructor(options: PluginManagerOptions) {
    this.monitorRegistry = options.monitorRegistry
    this.executorRegistry = options.executorRegistry
    this.strategyRegistry = options.strategyRegistry
    this.credentials = options.credentials
    this.registerAccountFactory = options.registerAccountFactory
  }

  load<TConfig>(factory: PluginFactory<TConfig>, config: TConfig): void {
    const context: PluginContext<TConfig> = { credentials: this.credentials, config }
    const plugin = factory(context)

    if (this.loadedPlugins.has(plugin.name)) {
      this.unload(plugin.name)
    }

    for (const { definition, instance } of plugin.monitors) {
      this.monitorRegistry.register(definition, instance)
    }
    for (const { definition, instance } of plugin.executors) {
      this.executorRegistry.register(definition, instance)
    }
    for (const { definition, factory: strategyFactory } of plugin.strategies) {
      this.strategyRegistry.register(definition, strategyFactory)
    }
    for (const { accountType, factory: accountFactory } of plugin.accounts) {
      this.registerAccountFactory?.(accountType, accountFactory)
    }

    this.loadedPlugins.set(plugin.name, plugin)
  }

  unload(pluginName: string): void {
    const plugin = this.loadedPlugins.get(pluginName)
    if (!plugin) return

    for (const { definition } of plugin.monitors) {
      this.monitorRegistry.unregister(definition.id)
    }
    for (const { definition } of plugin.executors) {
      this.executorRegistry.unregister(definition.id)
    }
    for (const { definition } of plugin.strategies) {
      this.strategyRegistry.unregister(definition.id)
    }

    this.loadedPlugins.delete(pluginName)
  }

  async loadFromPath<TConfig>(filePath: string, config: TConfig): Promise<void> {
    // webpackIgnore: true — suppress webpack critical dependency warning for dynamic import
    const mod = await import(/* webpackIgnore: true */ filePath) as { default?: PluginFactory<TConfig> }
    const factory = mod.default
    if (typeof factory !== 'function') {
      throw new Error(`Plugin at "${filePath}" must export a default factory function`)
    }
    this.load(factory, config)
  }

  listPlugins(): string[] {
    return Array.from(this.loadedPlugins.keys())
  }
}

