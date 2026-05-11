import type { StrategyInstance } from '../types/instance.js'
import type { ExecutionQueue } from '../types/executor.js'
import type { IRuntime, RuntimeOptions } from '../types/runtime.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../types/definition.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { IStrategy } from '../types/strategy.js'
import type { CredentialStore } from '../types/credential.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import type { AccountFactory, IAccount } from '../types/account.js'
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
  private readonly accountFactories = new Map<string, AccountFactory>()
  private readonly accountRegistry = new Map<string, IAccount>()
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

  registerStrategy(definition: StrategyDefinition, factory: () => IStrategy): void {
    this.strategyRegistry.register(definition, factory)
  }

  registerAccountFactory(accountType: string, factory: AccountFactory): void {
    this.accountFactories.set(accountType, factory)
  }

  async activate(instance: StrategyInstance): Promise<void> {
    // ① Create strategy instance from factory
    const strategyFactory = this.strategyRegistry.get(instance.strategyId)
    if (!strategyFactory) {
      throw new Error(`Strategy not found: ${instance.strategyId}`)
    }
    const strategy = strategyFactory()

    // ② Parse and validate params
    const parsedParams = this.parseParams(strategy, instance)

    // ③ Validate account types match
    this.validateAccounts(strategy, instance)

    // ④ Ensure account instances exist in registry
    const accounts = await this.ensureAccounts(instance)

    // ⑤ Generate triggers from strategy
    const rawTriggers = strategy.triggers(parsedParams)
    const triggers = rawTriggers.map((t, i) => ({
      ...t,
      id: `${instance.id}-trigger-${i}`,
      strategyInstanceId: instance.id,
    }))

    // ⑥ Register instance with TriggerManager (passes strategy + triggers)
    this.instances.set(instance.id, instance)
    this.triggerManager.registerInstance(instance.id, strategy, triggers, parsedParams, accounts)

    // ⑦ Persist instance
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
        const strategyFactory = this.strategyRegistry.get(instance.strategyId)
        if (strategyFactory) {
          const strategy = strategyFactory()
          const parsedParams = this.parseParams(strategy, instance)
          const accounts = await this.ensureAccounts(instance)
          const rawTriggers = strategy.triggers(parsedParams)
          const triggers = rawTriggers.map((t, i) => ({
            ...t,
            id: `${instance.id}-trigger-${i}`,
            strategyInstanceId: instance.id,
          }))
          this.instances.set(instance.id, instance)
          this.triggerManager.registerInstance(instance.id, strategy, triggers, parsedParams, accounts)
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

  // ── Private helpers ───────────────────────────────────────────────────────

  private parseParams(strategy: IStrategy, instance: StrategyInstance) {
    const base = instance.params?.base ?? {}
    const tunable = instance.params?.tunable ?? {}
    // Fill tunable defaults via Zod parse
    const parsedTunable = strategy.tunableParamsSchema.parse(tunable) as Record<string, unknown>
    return { base, tunable: parsedTunable }
  }

  private validateAccounts(strategy: IStrategy, instance: StrategyInstance): void {
    const accountTypes = strategy.accountTypes
    if (accountTypes.length === 0) return

    const accounts = instance.accounts ?? []
    if (accounts.length !== accountTypes.length) {
      throw new Error(
        `Strategy "${instance.strategyId}" requires ${accountTypes.length} account(s), but instance "${instance.id}" has ${accounts.length}`
      )
    }
  }

  private async ensureAccounts(instance: StrategyInstance): Promise<IAccount[]> {
    const credentialNames = instance.accounts ?? []
    const accounts: IAccount[] = []

    for (const credentialName of credentialNames) {
      if (!this.accountRegistry.has(credentialName)) {
        if (!this.credentialStore) {
          throw new Error(`CredentialStore not configured — cannot create account for "${credentialName}"`)
        }
        const { type, data } = await this.credentialStore.getByName(credentialName)
        const factory = this.accountFactories.get(type)
        if (!factory) {
          throw new Error(`No AccountFactory registered for type: "${type}" (credential: "${credentialName}")`)
        }
        this.accountRegistry.set(credentialName, factory(data))
      }
      const account = this.accountRegistry.get(credentialName)!
      accounts.push(account)
    }

    return accounts
  }
}
