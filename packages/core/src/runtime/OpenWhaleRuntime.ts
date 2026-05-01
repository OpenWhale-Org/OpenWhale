import type { StrategyBundle } from '../types/bundle.js'
import type { ExecutionQueue } from '../types/executor.js'
import type { IRuntime, RuntimeOptions } from '../types/runtime.js'
import type { IStrategy } from '../types/strategy.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../types/definition.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import { MemoryExecutionQueue } from '../executor/MemoryExecutionQueue.js'
import { TriggerManager } from '../trigger/TriggerManager.js'
import { Registry, createMonitorRegistry, createExecutorRegistry, createStrategyRegistry } from '../registry/Registry.js'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import { BundleStore } from '../bundle/BundleStore.js'
import type { PluginManager } from '../plugin/PluginManager.js'
import type { CompiledLoader } from '../compiled/CompiledLoader.js'
import { getDataDir } from '../utils/paths.js'

export class OpenWhaleRuntime implements IRuntime {
  private readonly bundles = new Map<string, StrategyBundle>()
  private readonly triggerManager = new TriggerManager()
  private readonly queue: ExecutionQueue
  private readonly monitorRegistry: MonitorRegistry
  private readonly executorRegistry: ExecutorRegistry
  private readonly strategyRegistry: StrategyRegistry
  private readonly bundleStore: BundleStore
  private readonly pluginManager: PluginManager | undefined
  private readonly compiledLoader: CompiledLoader | undefined
  protected readonly dataDir: string
  private running = false

  constructor(options?: RuntimeOptions) {
    this.dataDir = getDataDir(options?.dataDir)
    this.queue = options?.queue ?? new MemoryExecutionQueue()
    this.monitorRegistry = options?.monitorRegistry ?? createMonitorRegistry()
    this.executorRegistry = options?.executorRegistry ?? createExecutorRegistry()
    this.strategyRegistry = options?.strategyRegistry ?? createStrategyRegistry()
    this.bundleStore = options?.bundleStore ?? new BundleStore(this.dataDir)
    this.pluginManager = options?.pluginManager
    this.compiledLoader = options?.compiledLoader
  }

  registerMonitor(definition: MonitorDefinition, instance: BaseMonitor): void {
    this.monitorRegistry.register(definition, instance)
    this.triggerManager.registerMonitor(instance)
  }

  registerExecutor(definition: ExecutorDefinition, instance: BaseExecutor): void {
    this.executorRegistry.register(definition, instance)
  }

  registerStrategy(definition: StrategyDefinition, instance: IStrategy): void {
    this.strategyRegistry.register(definition, instance)
  }

  async activate(bundle: StrategyBundle): Promise<void> {
    const strategy = this.strategyRegistry.get(bundle.strategyId)
    if (!strategy) {
      throw new Error(`Strategy not found: ${bundle.strategyId}`)
    }
    this.bundles.set(bundle.id, bundle)
    this.triggerManager.registerBundle(bundle.id, bundle.triggers, strategy)
    await this.bundleStore.save(bundle)
  }

  async deactivate(bundleId: string): Promise<void> {
    this.bundles.delete(bundleId)
    this.triggerManager.unregisterBundle(bundleId)
    await this.bundleStore.delete(bundleId)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    // Load compiled components
    if (this.compiledLoader) {
      await this.compiledLoader.loadAll()
    }

    // Register compiled monitors into TriggerManager
    for (const def of this.monitorRegistry.list()) {
      const instance = this.monitorRegistry.get(def.id)
      if (instance) this.triggerManager.registerMonitor(instance)
    }

    // Load and activate persisted bundles
    const persistedBundles = await this.bundleStore.loadAll()
    for (const bundle of persistedBundles) {
      if (!this.bundles.has(bundle.id)) {
        const strategy = this.strategyRegistry.get(bundle.strategyId)
        if (strategy) {
          this.bundles.set(bundle.id, bundle)
          this.triggerManager.registerBundle(bundle.id, bundle.triggers, strategy)
        }
      }
    }

    this.triggerManager.start(this.queue)

    // Start executors from registry
    for (const def of this.executorRegistry.list()) {
      const executor = this.executorRegistry.get(def.id)
      if (executor) void executor.run(this.queue)
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.triggerManager.stop()
    await this.queue.stop()
  }

  listBundles(): StrategyBundle[] {
    return Array.from(this.bundles.values())
  }
}
