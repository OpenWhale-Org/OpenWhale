import type { CredentialStore } from '../types/credential.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { IStrategy } from '../types/strategy.js'
import type { AdapterRegistration, AdapterResolver, CredentialTypeDefinition, PublicSessionRegistration, PublicSessionAccessor } from '../types/materialization.js'
import type { AccountImplementation } from '../types/account.js'
import type { MonitorImplementation } from '../types/monitorInstance.js'
import type { AccountClass, MonitorClass } from './componentDecorators.js'
import type { ScriptDefinition } from '../types/script.js'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../types/definition.js'

export interface OpenWhalePlugin {
  name: string
  version: string
  /** Markdown README shown on the dashboard's Plugins page. */
  readme?: string
  /** @deprecated Legacy singleton registrations — new code uses `monitorImplementations` (or definePlugin's class arrays). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitors?: Array<{ definition: MonitorDefinition; instance: BaseMonitor<string, any> }>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executors?: Array<{ definition: ExecutorDefinition; instance: BaseExecutor<any> }>
  /** Strategy factories — each activate() call creates a fresh instance. */
  strategies?: Array<{ definition: StrategyDefinition; factory: () => IStrategy }>
  // NOTE: kinds need no plugin field — the vocabulary is DERIVED from the
  // matrix (adapter cells + account implementations); a domain package
  // "registers" a kind by contributing its mock cell + generic account impl
  // and merging the AdapterKindMap type declaration.
  /**
   * Credential type recipes this plugin registers: schema (drives the
   * credential form), raw opt-in, and test.
   */
  credentialTypes?: CredentialTypeDefinition[]
  /** Scripts — operator utilities run on demand from the dashboard. */
  scripts?: ScriptDefinition[]
  /**
   * Adapter cells this plugin contributes to the type × kind matrix — one
   * factory per (kind, type), credential optional (the keyless form serves
   * public market data). Consumers resolve instances via the AdapterResolver.
   */
  adapters?: AdapterRegistration[]
  /**
   * Account implementations this plugin offers: kind-generic (domain package)
   * or (kind, type)-specialized (venue package). Users create Account entities
   * from these on the dashboard. Ids are qualified '<plugin>/<id>' at load.
   */
  accounts?: Array<AccountImplementation | AccountClass>
  /**
   * Monitor implementations (contract / implementation / instance model).
   * The contract's façade is what triggers and the dashboard address; users
   * create instances (optionally credential-bound) to do the listening.
   * Same-contract entries from other plugins are specializations, dispatched
   * leaf-first by keySchema match.
   */
  monitorImplementations?: Array<MonitorImplementation | MonitorClass>
  /**
   * Credential-less read-only session factories (public market data).
   * @deprecated Converted at load into keyless-only adapter cells with
   * type = plugin name. Use `adapters`.
   */
  publicSessions?: PublicSessionRegistration[]
}

export interface PluginContext<TConfig = Record<string, unknown>> {
  credentials: CredentialStore
  config: TConfig
  /**
   * The runtime's AdapterResolver (set when loaded through the runtime).
   * Late-bound: resolve inside monitor/component code at use time, not in the
   * plugin factory — other plugins' cells may register after this one loads.
   */
  adapters?: AdapterResolver
  /**
   * Public session registry view (set when loaded through the runtime).
   * @deprecated Shim over `adapters` (venue = credential type, keyless form).
   */
  publicSessions?: PublicSessionAccessor
}

export type PluginFactory<TConfig = Record<string, unknown>> = (
  context: PluginContext<TConfig>
) => OpenWhalePlugin

export interface PluginManagerOptions {
  monitorRegistry: MonitorRegistry
  executorRegistry: ExecutorRegistry
  strategyRegistry: StrategyRegistry
  credentials: CredentialStore
}

export class PluginManager {
  private readonly monitorRegistry: MonitorRegistry
  private readonly executorRegistry: ExecutorRegistry
  private readonly strategyRegistry: StrategyRegistry
  private readonly credentials: CredentialStore
  private readonly loadedPlugins = new Map<string, OpenWhalePlugin>()

  constructor(options: PluginManagerOptions) {
    this.monitorRegistry = options.monitorRegistry
    this.executorRegistry = options.executorRegistry
    this.strategyRegistry = options.strategyRegistry
    this.credentials = options.credentials
  }

  load<TConfig>(factory: PluginFactory<TConfig>, config: TConfig): void {
    const context: PluginContext<TConfig> = { credentials: this.credentials, config }
    const plugin = factory(context)

    if (this.loadedPlugins.has(plugin.name)) {
      this.unload(plugin.name)
    }

    for (const { definition, instance } of plugin.monitors ?? []) {
      this.monitorRegistry.register(definition, instance)
    }
    for (const { definition, instance } of plugin.executors ?? []) {
      this.executorRegistry.register(definition, instance)
    }
    for (const { definition, factory: strategyFactory } of plugin.strategies ?? []) {
      this.strategyRegistry.register(definition, strategyFactory)
    }

    this.loadedPlugins.set(plugin.name, plugin)
  }

  unload(pluginName: string): void {
    const plugin = this.loadedPlugins.get(pluginName)
    if (!plugin) return

    for (const { definition } of plugin.monitors ?? []) {
      this.monitorRegistry.unregister(definition.id)
    }
    for (const { definition } of plugin.executors ?? []) {
      this.executorRegistry.unregister(definition.id)
    }
    for (const { definition } of plugin.strategies ?? []) {
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

