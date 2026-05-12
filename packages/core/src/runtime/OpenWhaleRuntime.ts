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
import type { RawCredentialData } from '../types/credential.js'
import { MemoryExecutionQueue } from '../executor/MemoryExecutionQueue.js'
import { TriggerManager } from '../trigger/TriggerManager.js'
import type { StrategyRunEvent } from '../trigger/TriggerManager.js'
import { createMonitorRegistry, createExecutorRegistry, createStrategyRegistry } from '../registry/Registry.js'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import { StrategyInstanceStore } from '../bundle/StrategyInstanceStore.js'
import { DBStrategyInstanceStore } from '../bundle/DBStrategyInstanceStore.js'
import type { PluginManager, PluginFactory } from '../plugin/PluginManager.js'
import { CompiledLoader } from '../compiled/CompiledLoader.js'
import { getDataDir } from '../utils/paths.js'

export class OpenWhaleRuntime implements IRuntime {
  private readonly instances = new Map<string, StrategyInstance>()
  private readonly monitorRegistry: MonitorRegistry
  private readonly executorRegistry: ExecutorRegistry
  private readonly strategyRegistry: StrategyRegistry
  private readonly triggerManager: TriggerManager
  private readonly queue: ExecutionQueue
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
    this.triggerManager = new TriggerManager(this.monitorRegistry, options?.credentialStore, options?.database)
    this.database = options?.database
    this.instanceStore = options?.instanceStore
      ?? (this.database ? new DBStrategyInstanceStore(this.database) : new StrategyInstanceStore(this.dataDir))
    this.pluginManager = options?.pluginManager
    this.compiledLoader = options?.compiledLoader
      ?? new CompiledLoader({
        monitorRegistry: this.monitorRegistry,
        executorRegistry: this.executorRegistry,
        strategyRegistry: this.strategyRegistry,
        dataDir: this.dataDir,
      })
    this.credentialStore = options?.credentialStore
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMonitor(definition: MonitorDefinition, instance: BaseMonitor<string, any>): void {
    this.monitorRegistry.register(definition, instance)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerExecutor(definition: ExecutorDefinition, instance: BaseExecutor<any>): void {
    this.executorRegistry.register(definition, instance)
  }

  registerStrategy(definition: StrategyDefinition, factory: () => IStrategy): void {
    // Extract paramsFields from a temporary strategy instance if not already in definition
    if (!definition.paramsFields) {
      const probe = factory()
      const fields = probe.paramsFields
      if (fields && fields.length > 0) {
        this.strategyRegistry.register({ ...definition, paramsFields: fields }, factory)
        return
      }
    }
    this.strategyRegistry.register(definition, factory)
  }

  registerAccountFactory(accountType: string, factory: AccountFactory): void {
    this.accountFactories.set(accountType, factory)
  }

  loadPlugin<TConfig>(factory: PluginFactory<TConfig>, config: TConfig): void {
    const plugin = factory({ credentials: this.credentialStore!, config })
    for (const { definition, instance } of plugin.monitors) this.registerMonitor(definition, instance)
    for (const { definition, instance } of plugin.executors) this.registerExecutor(definition, instance)
    for (const { definition, factory: sf } of plugin.strategies) this.registerStrategy(definition, sf)
    for (const { accountType, factory: af } of plugin.accounts) this.registerAccountFactory(accountType, af)
  }

  setStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void {
    this.triggerManager.setStrategyRunHandler(handler)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    // Initialize database schema if a database adapter is provided
    if (this.database) await this.database.initialize()

    // Load compiled components
    if (this.compiledLoader) await this.compiledLoader.loadAll()

    // Load and activate persisted instances
    const persistedInstances = await this.instanceStore.loadAll()
    for (const instance of persistedInstances) {
      if (!this.instances.has(instance.id))
        await this.activateInstance(instance, { persist: false })
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
    if (this.database) await this.database.close()
  }

  async activate(instance: StrategyInstance): Promise<void> {
    await this.activateInstance(instance, { persist: true })
  }

  async deactivate(instanceId: string): Promise<void> {
    this.instances.delete(instanceId)
    this.triggerManager.unregisterInstance(instanceId)
    await this.instanceStore.delete(instanceId)
  }

  listInstances(): StrategyInstance[] {
    return Array.from(this.instances.values())
  }

  listStrategies(): StrategyDefinition[] {
    return this.strategyRegistry.list()
  }

  listMonitors(): MonitorDefinition[] {
    return this.monitorRegistry.list()
  }

  listExecutors(): ExecutorDefinition[] {
    return this.executorRegistry.list()
  }

  getMonitor(id: string): BaseMonitor | undefined {
    return this.monitorRegistry.get(id)
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Core activation logic shared by activate() and start().
   * persist=true  → throw if strategy missing, save to instanceStore (activate path)
   * persist=false → skip if strategy missing, no save (start/restore path)
   */
  private async activateInstance(instance: StrategyInstance, { persist }: { persist: boolean }): Promise<void> {
    const strategyFactory = this.strategyRegistry.get(instance.strategyId)
    if (!strategyFactory) {
      if (persist) throw new Error(`Strategy not found: ${instance.strategyId}`)
      return
    }

    const strategy = strategyFactory()
    const parsedParams = this.parseParams(strategy, instance)
    const accounts = await this.ensureAccounts(instance, strategy)
    const triggers = strategy.triggers(parsedParams).map((t, i) => ({
      ...t,
      id: `${instance.id}-trigger-${i}`,
      strategyInstanceId: instance.id,
    }))

    this.instances.set(instance.id, instance)
    this.triggerManager.registerInstance(instance.id, strategy, triggers, parsedParams, accounts)

    if (persist) await this.instanceStore.save(instance)
  }

  private parseParams(strategy: IStrategy, instance: StrategyInstance) {
    const base = instance.params?.base ?? {}
    const tunable = instance.params?.tunable ?? {}
    // Fill tunable defaults via Zod parse
    const parsedTunable = strategy.tunableParamsSchema.parse(tunable) as RawCredentialData
    return { base, tunable: parsedTunable }
  }

  private async ensureAccounts(instance: StrategyInstance, strategy: IStrategy): Promise<IAccount[]> {
    const credentialNames = instance.accounts ?? []

    if (credentialNames.length !== strategy.accountTypes.length) {
      throw new Error(
        `Strategy "${instance.strategyId}" requires ${strategy.accountTypes.length} account(s), ` +
        `but instance "${instance.id}" has ${credentialNames.length}`
      )
    }

    const accounts: IAccount[] = []
    for (let i = 0; i < credentialNames.length; i++) {
      const name = credentialNames[i]!
      const expectedType = strategy.accountTypes[i]!
      const expectedTypeName = typeof expectedType === 'string' ? expectedType : expectedType.type

      if (!this.accountRegistry.has(name)) {
        if (!this.credentialStore) {
          throw new Error(`CredentialStore not configured — cannot create account for "${name}"`)
        }
        const { type, data } = await this.credentialStore.getByName(name)
        if (type !== expectedTypeName) {
          throw new Error(
            `Account[${i}] type mismatch: strategy "${instance.strategyId}" expects "${expectedTypeName}", ` +
            `but credential "${name}" has type "${type}"`
          )
        }
        const factory = this.accountFactories.get(type)
        if (!factory) {
          throw new Error(`No AccountFactory registered for type: "${type}" (credential: "${name}")`)
        }
        this.accountRegistry.set(name, factory(data))
      }
      accounts.push(this.accountRegistry.get(name)!)
    }

    return accounts
  }
}
