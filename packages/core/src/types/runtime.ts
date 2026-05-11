import type { StrategyInstance } from './instance.js'
import type { ExecutionQueue } from './executor.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from './definition.js'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import type { StrategyInstanceStore } from '../bundle/StrategyInstanceStore.js'
import type { PluginManager } from '../plugin/PluginManager.js'
import type { CompiledLoader } from '../compiled/CompiledLoader.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { IStrategy } from './strategy.js'
import type { CredentialStore } from './credential.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import type { AccountFactory } from './account.js'

export interface RuntimeOptions {
  dataDir?: string
  queue?: ExecutionQueue
  monitorRegistry?: MonitorRegistry
  executorRegistry?: ExecutorRegistry
  strategyRegistry?: StrategyRegistry
  instanceStore?: StrategyInstanceStore
  pluginManager?: PluginManager
  compiledLoader?: CompiledLoader
  credentialStore?: CredentialStore
  /** SQL database adapter. When provided, instances and credentials are persisted to DB. */
  database?: DatabaseAdapter
}

export interface IRuntime {
  activate(instance: StrategyInstance): Promise<void>
  deactivate(instanceId: string): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  listInstances(): StrategyInstance[]
  registerMonitor(definition: MonitorDefinition, instance: BaseMonitor): void
  registerExecutor(definition: ExecutorDefinition, instance: BaseExecutor): void
  registerStrategy(definition: StrategyDefinition, factory: () => IStrategy): void
  registerAccountFactory(accountType: string, factory: AccountFactory): void
}
