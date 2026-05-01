import type { StrategyBundle } from './bundle.js'
import type { ExecutionQueue } from './executor.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from './definition.js'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import type { BundleStore } from '../bundle/BundleStore.js'
import type { PluginManager } from '../plugin/PluginManager.js'
import type { CompiledLoader } from '../compiled/CompiledLoader.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { IStrategy } from './strategy.js'

export interface RuntimeOptions {
  dataDir?: string
  queue?: ExecutionQueue
  monitorRegistry?: MonitorRegistry
  executorRegistry?: ExecutorRegistry
  strategyRegistry?: StrategyRegistry
  bundleStore?: BundleStore
  pluginManager?: PluginManager
  compiledLoader?: CompiledLoader
}

export interface IRuntime {
  activate(bundle: StrategyBundle): Promise<void>
  deactivate(bundleId: string): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  listBundles(): StrategyBundle[]
  registerMonitor(definition: MonitorDefinition, instance: BaseMonitor): void
  registerExecutor(definition: ExecutorDefinition, instance: BaseExecutor): void
  registerStrategy(definition: StrategyDefinition, instance: IStrategy): void
}
