import type { StrategyInstance } from './instance.js'
import type { ExecutionQueue } from './executor.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from './definition.js'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import type { StrategyInstanceStore } from '../bundle/StrategyInstanceStore.js'
import type { PluginManager, PluginFactory } from '../plugin/PluginManager.js'
import type { CompiledLoader } from '../compiled/CompiledLoader.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { IStrategy } from './strategy.js'
import type { CredentialStore } from './credential.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import type { CredentialTypeDefinition } from './materialization.js'
import type { DBStrategyInstanceStore } from '../bundle/DBStrategyInstanceStore.js'
import type { StrategyRunEvent } from '../trigger/TriggerManager.js'

export interface RuntimeOptions {
  dataDir?: string
  queue?: ExecutionQueue
  monitorRegistry?: MonitorRegistry
  executorRegistry?: ExecutorRegistry
  strategyRegistry?: StrategyRegistry
  instanceStore?: StrategyInstanceStore | DBStrategyInstanceStore
  pluginManager?: PluginManager
  compiledLoader?: CompiledLoader
  credentialStore?: CredentialStore
  /** SQL database adapter. When provided, instances and credentials are persisted to DB. */
  database?: DatabaseAdapter
  /** Equity snapshotter tuning (Accounts page curves). Defaults: 5min interval, 30d retention. */
  accountSnapshots?: { intervalMs?: number; retentionMs?: number }
}

/** Summary of a loaded plugin: its namespace and the registry ids it contributed. */
export interface LoadedPluginInfo {
  name: string
  version: string
  monitors: string[]
  executors: string[]
  strategies: string[]
  kinds: string[]
  credentialTypes: string[]
}

export interface IRuntime {
  activate(instance: StrategyInstance): Promise<void>
  deactivate(instanceId: string): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  listInstances(): StrategyInstance[]
  listStrategies(): StrategyDefinition[]
  listMonitors(): MonitorDefinition[]
  listExecutors(): ExecutorDefinition[]
  getMonitor(id: string): BaseMonitor | undefined
  registerMonitor(definition: MonitorDefinition, instance: BaseMonitor): void
  registerExecutor(definition: ExecutorDefinition, instance: BaseExecutor): void
  registerStrategy(definition: StrategyDefinition, factory: () => IStrategy): void
  registerCredentialType(definition: CredentialTypeDefinition): void
  listCredentialTypes(): CredentialTypeDefinition[]
  loadPlugin<TConfig>(factory: PluginFactory<TConfig>, config: TConfig): string
  loadPluginFromPath(filePath: string, config: unknown): Promise<string>
  unloadPlugin(name: string): void
  listLoadedPlugins(): LoadedPluginInfo[]
  addStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void
  removeStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void
  /** @deprecated Use addStrategyRunHandler instead */
  setStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void
}
