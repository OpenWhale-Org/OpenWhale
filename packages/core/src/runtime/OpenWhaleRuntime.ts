import type { StrategyInstance } from '../types/instance.js'
import type { ExecutionQueue } from '../types/executor.js'
import type { IRuntime, RuntimeOptions } from '../types/runtime.js'
import type { IStrategy } from '../types/strategy.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../types/definition.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { CredentialStore } from '../types/credential.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import { MemoryExecutionQueue } from '../executor/MemoryExecutionQueue.js'
import { TriggerManager } from '../trigger/TriggerManager.js'
import { createMonitorRegistry, createExecutorRegistry, createStrategyRegistry } from '../registry/Registry.js'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import { StrategyInstanceStore } from '../bundle/StrategyInstanceStore.js'
import { DBStrategyInstanceStore } from '../bundle/DBStrategyInstanceStore.js'
import type { PluginManager } from '../plugin/PluginManager.js'
import type { CompiledLoader } from '../compiled/CompiledLoader.js'
import { getDataDir } from '../utils/paths.js'

export class OpenWhaleRuntime implements IRuntime {
  private readonly instances = new Map<string, StrategyInstance>()
  private readonly triggerManager = new TriggerManager()
  private readonly queue: ExecutionQueue
  private readonly monitorRegistry: MonitorRegistry
  private readonly executorRegistry: ExecutorRegistry
  private readonly strategyRegistry: StrategyRegistry
  private readonly instanceStore: StrategyInstanceStore | DBStrategyInstanceStore
  private readonly pluginManager: PluginManager | undefined
  private readonly compiledLoader: CompiledLoader | undefined
  private readonly credentialStore: CredentialStore | undefined
  private readonly database: DatabaseAdapter | undefined
  protected readonly dataDir: string
  private running = false

  constructor(options?: RuntimeOptions) {
    this.dataDir = getDataDir(options?.dataDir)
    this.queue = options?.queue ?? new MemoryExecutionQueue()
    this.monitorRegistry = options?.monitorRegistry ?? createMonitorRegistry()
    this.executorRegistry = options?.executorRegistry ?? createExecutorRegistry()
    this.strategyRegistry = options?.strategyRegistry ?? createStrategyRegistry()
    this.database = options?.database
    this.instanceStore = options?.instanceStore
      ?? (this.database ? new DBStrategyInstanceStore(this.database) : new StrategyInstanceStore(this.dataDir))
    this.pluginManager = options?.pluginManager
    this.compiledLoader = options?.compiledLoader
    this.credentialStore = options?.credentialStore
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

  async activate(instance: StrategyInstance): Promise<void> {
    const strategy = this.strategyRegistry.get(instance.strategyId)
    if (!strategy) {
      throw new Error(`Strategy not found: ${instance.strategyId}`)
    }
    this.instances.set(instance.id, instance)
    this.triggerManager.registerInstance(instance.id, instance.triggers, strategy)
    await this.instanceStore.save(instance)
  }

  async deactivate(instanceId: string): Promise<void> {
    this.instances.delete(instanceId)
    this.triggerManager.unregisterInstance(instanceId)
    await this.instanceStore.delete(instanceId)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    // Initialize database schema if a database adapter is provided
    if (this.database) {
      await this.database.initialize()
    }

    // Load compiled components
    if (this.compiledLoader) {
      await this.compiledLoader.loadAll()
    }

    // Register compiled monitors into TriggerManager
    for (const def of this.monitorRegistry.list()) {
      const instance = this.monitorRegistry.get(def.id)
      if (instance) this.triggerManager.registerMonitor(instance)
    }

    // Load and activate persisted instances
    const persistedInstances = await this.instanceStore.loadAll()
    for (const instance of persistedInstances) {
      if (!this.instances.has(instance.id)) {
        const strategy = this.strategyRegistry.get(instance.strategyId)
        if (strategy) {
          this.instances.set(instance.id, instance)
          this.triggerManager.registerInstance(instance.id, instance.triggers, strategy)
        }
      }
    }

    this.triggerManager.start(this.queue, this.credentialStore, this.database)

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
    if (this.database) {
      await this.database.close()
    }
  }

  listInstances(): StrategyInstance[] {
    return Array.from(this.instances.values())
  }
}
