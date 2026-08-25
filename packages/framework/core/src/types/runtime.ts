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
  /**
   * The NAMESPACE this install occupies — what every id it registers is
   * prefixed with, and the key it is addressed by.
   *
   * Usually the name the package gives itself, but not necessarily: plugin
   * names are not globally unique (two people can both publish a
   * `funding-arb`), while a namespace has to be unique on one machine or the
   * two would silently overwrite each other's strategies. So a second plugin
   * claiming a taken name is installed under a different namespace instead.
   */
  name: string
  /** What the package calls itself, when that is not the namespace it got. */
  declaredName?: string
  version: string
  /** Markdown shipped by the plugin (manifest `readme`) — the Plugins page's detail pane. */
  readme?: string
  /** Brand mark (https URL or data: URI); the dashboard falls back to a credential type's mark, then a letter chip. */
  logo?: string
  icon?: string
  /** Monitor ids: legacy singleton registrations + implementation contract ids. */
  monitors: string[]
  executors: string[]
  strategies: string[]
  /** Account implementation ids ('<plugin>/<id>'). */
  accounts: string[]
  /** Script ids ('<plugin>/<id>'). */
  scripts: string[]
  kinds: string[]
  credentialTypes: string[]
  /** Adapter cells this plugin contributed to the matrix. */
  cells: Array<{ kind: string; venue: string }>
}

/**
 * Thrown when the namespace a plugin wants is taken — the signal to ask
 * whether this is a new version of what is there, or a different plugin that
 * happens to share a name and needs one of its own.
 */
export class PluginAlreadyLoadedError extends Error {
  constructor(
    /** The namespace already in use. */
    public readonly pluginName: string,
    /** What the incoming package calls itself, when it differs from the namespace. */
    public readonly declaredName?: string,
  ) {
    super(`Plugin namespace "${pluginName}" is already in use — unload it first, or install under another namespace`)
    this.name = 'PluginAlreadyLoadedError'
  }
}

/** Outcome of loading a plugin over one already loaded. */
export interface PluginReplaceResult {
  name: string
  /** False when nothing was loaded under this name and it was a plain load. */
  replaced: boolean
  /** Instances that were running before and are running again. */
  resumed: string[]
  /** Instances that were running and could not restart — their strategy is gone. */
  orphaned: string[]
}

/**
 * What a plugin still owns, asked before removing it.
 *
 * Split by what the answer costs the user rather than by entity type. The
 * first three are things a person built and named — an instance's params, a
 * credential's secret, an account's history — and deleting them as a side
 * effect of "uninstall" would be a data loss they never asked for, so they
 * block instead. Monitor instances are the plugin's own plumbing (a
 * contract's runner, usually created for you), meaningless once the code is
 * gone, so uninstall clears them itself.
 */
export interface PluginDependents {
  /** Strategy instance ids running one of the plugin's strategies. */
  instances: string[]
  /** Account names bound to one of the plugin's account implementations. */
  accounts: string[]
  /** Credential names of a type this plugin registered. */
  credentials: string[]
  /** Monitor instance ids of the plugin's implementations — deleted, not blocking. */
  monitorInstances: string[]
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
