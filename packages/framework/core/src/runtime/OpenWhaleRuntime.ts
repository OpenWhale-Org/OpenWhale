import { pathToFileURL } from 'url'
import type { StrategyInstance, StrategyInstanceView } from '../types/instance.js'
import type { ExecutionQueue } from '../types/executor.js'
import type { IRuntime, RuntimeOptions, LoadedPluginInfo, PluginDependents, PluginReplaceResult, PluginGlobalConflict } from '../types/runtime.js'
import { PluginAlreadyLoadedError } from '../types/runtime.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../types/definition.js'
import type { Trigger } from '../types/trigger.js'
import type { PlotOption } from '../types/monitor.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { IStrategy } from '../types/strategy.js'
import type { CredentialStore } from '../types/credential.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import type { AdapterResolver, CredentialTypeDefinition, CredentialTypeInfo, NamespacedKind, PublicSessionAccessor } from '../types/materialization.js'
import type { AccountEntity, AccountImplementation, AccountImplementationInfo, AccountSnapshotRecord, AccountSnapshotSample, AccountSnapshotStore, AccountStore, AccountView } from '../types/account.js'
import { implementationVenue } from '../types/account.js'
import { cellVenue } from '../types/materialization.js'
import { AdapterRegistry } from './AdapterRegistry.js'
import { DBAccountStore, MemoryAccountStore } from '../account/AccountStore.js'
import { DBAccountSnapshotStore, MemoryAccountSnapshotStore } from '../account/AccountSnapshotStore.js'
import { MonitorInstanceManager } from '../monitor/MonitorInstanceManager.js'
import { DBMonitorInstanceStore, MemoryMonitorInstanceStore } from '../monitor/MonitorInstanceStore.js'
import type { MonitorImplementation, MonitorInstanceEntity, MonitorInstanceView } from '../types/monitorInstance.js'
import { z } from 'zod'
import type { MaterializedSlot } from '../executor/BaseExecutor.js'
import type { RawCredentialData } from '../types/credential.js'
import { MemoryExecutionQueue } from '../executor/MemoryExecutionQueue.js'
import { TriggerManager } from '../trigger/TriggerManager.js'
import { appendRunTrace, readRunTraces, countRunsSince } from '../strategy/runStore.js'
import { PortfolioJournal } from '../strategy/PortfolioJournal.js'
import type { PortfolioReport, PortfolioReportQuery } from '../types/portfolio.js'
import type { StrategyRunTrace } from '../types/strategy.js'
import { BaseStrategy } from '../strategy/BaseStrategy.js'
import type { ScriptDefinition, ScriptInfo, ScriptResult } from '../types/script.js'
import { PnlService } from '../pnl/PnlService.js'
import type { PnlSessionLike, PnlSummary, PnlFillRow, PnlPositionRow, PnlSeriesPoint } from '../pnl/PnlService.js'
import type { StrategyRunEvent } from '../trigger/TriggerManager.js'
import { createMonitorRegistry, createExecutorRegistry, createStrategyRegistry } from '../registry/Registry.js'
import type { MonitorRegistry, ExecutorRegistry, StrategyRegistry } from '../registry/Registry.js'
import { StrategyInstanceStore } from '../bundle/StrategyInstanceStore.js'
import { DBStrategyInstanceStore } from '../bundle/DBStrategyInstanceStore.js'
import type { PluginManager, PluginFactory, OpenWhalePlugin } from '../plugin/PluginManager.js'
import { lowerAccountEntry, lowerMonitorEntry } from '../plugin/definePlugin.js'
import { CompiledLoader } from '../compiled/CompiledLoader.js'
import { llmCredentialTypes } from '../credentials/llmCredentialTypes.js'
import { BaseStrategy as BaseStrategyClass } from '../strategy/BaseStrategy.js'
import { getDataDir } from '../utils/paths.js'
import { generateId } from '../utils/id.js'
import { createLogger } from '../utils/logger.js'
import type { MonitorDeclaration } from '../types/strategy.js'

const log = createLogger('OpenWhaleRuntime')

/**
 * Resolve a viewer's plot-option request against the options that exist in the
 * current record window.
 *
 * Single-select: the requested value if still present, else the first option.
 * Multi-select: the requested values that survive, else the options flagged
 * `default`, else the first — extract never sees an empty or stale selection,
 * so a panel can index into its data without defensive checks.
 */
function resolvePlotSelection(
  options: PlotOption[] | undefined,
  requested: string | string[] | undefined,
  multi: boolean,
): string | string[] | undefined {
  if (!options?.length) return undefined
  const valid = new Set(options.map(o => o.value))

  if (!multi) {
    const one = Array.isArray(requested) ? requested[0] : requested
    return one !== undefined && valid.has(one) ? one : options[0]!.value
  }

  const asked = (Array.isArray(requested) ? requested : requested !== undefined ? [requested] : [])
    .filter(v => valid.has(v))
  if (asked.length > 0) return asked
  const defaults = options.filter(o => o.default).map(o => o.value)
  return defaults.length > 0 ? defaults : [options[0]!.value]
}

/** Names containing '/' are already fully qualified; others get the plugin namespace prefix. */
function resolveComponentName(name: string, ns: string | undefined): string {
  if (name.includes('/')) return name
  return ns ? `${ns}/${name}` : name
}

function declarationName(decl: MonitorDeclaration): string {
  return typeof decl === 'string' ? decl : decl.name
}

function declarationLabel(decl: MonitorDeclaration): string {
  return typeof decl === 'string' ? decl : decl.label
}

function buildLabelToKeyMap(declarations: readonly MonitorDeclaration[], ns: string | undefined): Map<string, string> {
  return new Map(declarations.map(d => [declarationLabel(d), resolveComponentName(declarationName(d), ns)]))
}

function sessionKey(credentialName: string, kind: string, venue?: string): string {
  return venue !== undefined ? `${credentialName}::${kind}::${venue}` : `${credentialName}::${kind}`
}

function assertNamespacedKind(kind: string): void {
  if (!/^[^/]+\/[^/]+$/.test(kind)) {
    throw new Error(`Invalid kind "${kind}" — every kind must be namespaced as 'ns/name' (e.g. 'exchange/perp')`)
  }
}

/** How a plugin is loaded — currently just which namespace it takes. */
export interface PluginLoadOptions {
  /**
   * Namespace to install under, instead of the name the package declares.
   *
   * The escape hatch for the fact that plugin names are not globally unique:
   * two authors can each publish a `funding-arb`, and without this the second
   * one is unusable — its ids would collide with the first's, silently, since
   * the component registries are last-writer-wins.
   *
   * It is chosen once, at install, and cannot change afterwards: instances
   * persist `<namespace>/<strategy>`, so renaming would orphan every one.
   */
  as?: string
}

/** Namespaces become the first segment of every id the plugin registers. */
function resolveNamespace(plugin: OpenWhalePlugin, opts?: PluginLoadOptions): string {
  const ns = opts?.as?.trim()
  if (!ns) return plugin.name
  if (!/^[a-z0-9][\w.-]*$/i.test(ns)) {
    throw new Error(`"${ns}" is not a usable plugin namespace — letters, digits, dot, dash and underscore only, and no "/"`)
  }
  return ns
}

/** Import a built plugin module and hand back its default-exported factory. */
async function importPluginFactory(filePath: string): Promise<PluginFactory<unknown>> {
  // webpackIgnore: true — keep bundlers from trying to resolve the dynamic path
  const mod = await import(/* webpackIgnore: true */ pathToFileURL(filePath).href) as { default?: PluginFactory<unknown> }
  const factory = mod.default
  if (typeof factory !== 'function') {
    throw new Error(`Plugin module at "${filePath}" must default-export a plugin factory function`)
  }
  return factory
}

export class OpenWhaleRuntime implements IRuntime {
  private readonly instances = new Map<string, StrategyInstance>()
  private readonly monitorRegistry: MonitorRegistry
  private readonly executorRegistry: ExecutorRegistry
  private readonly strategyRegistry: StrategyRegistry
  private readonly triggerManager: TriggerManager
  private readonly queue: ExecutionQueue
  private readonly instanceStore: StrategyInstanceStore | DBStrategyInstanceStore
  private readonly pluginManager: PluginManager | undefined
  private readonly compiledLoader: CompiledLoader
  private readonly credentialStore: CredentialStore | undefined
  private readonly database: DatabaseAdapter | undefined
  private readonly credentialTypes = new Map<string, CredentialTypeDefinition>()
  /** Registering plugin per credential type ('core' for built-ins) — picker grouping. */
  private readonly credentialTypeOwners = new Map<string, string>()
  /** Live sessions keyed by `${credentialName}::${kind}`, with referencing instances. */
  private readonly sessions = new Map<string, { session: unknown; instances: Set<string> }>()
  /** The adapter cell table + resolver — the single gateway to adapter instances. */
  private readonly adapterRegistry: AdapterRegistry
  /** Registered account implementations, keyed by qualified id '<plugin>/<id>'. */
  private readonly accountImpls = new Map<string, { impl: AccountImplementation; owner: string }>()
  /** Persisted account entities (DB when available, memory otherwise). */
  private readonly accountStore: AccountStore
  /** Equity snapshots feeding the Accounts page's curves. */
  private readonly accountSnapshots: AccountSnapshotStore
  /** Last snapshot failure per account — silent-failure killer for the Accounts page. */
  private readonly accountSnapshotErrors = new Map<string, string>()
  private accountSnapshotTimer: ReturnType<typeof setInterval> | undefined
  private readonly accountSnapshotIntervalMs: number
  private readonly accountSnapshotRetentionMs: number
  /** Monitor contract/implementation/instance tables + key dispatch. */
  private readonly monitorInstances: MonitorInstanceManager

  /** The AdapterResolver — components declare (kind, type, credential need) and resolve here. */
  get adapters(): AdapterResolver {
    return this.adapterRegistry
  }

  /** Root data directory (monitor JSONL, executions…) — dashboard explorer / open-folder. */
  get dataDirPath(): string {
    return this.dataDir
  }

  /**
   * Late-bound public session registry view (handed to plugin factories).
   * @deprecated Thin shim over the AdapterResolver (venue = credential type,
   * keyless form). Migrate consumers to `adapters`.
   */
  readonly publicSessions: PublicSessionAccessor = {
    venues: (kind) => this.adapterRegistry.types(kind),
    get: <T,>(venue: string, kind: NamespacedKind): Promise<T> => this.adapterRegistry.resolve<T>(kind, venue),
  }
  private readonly loadedPlugins = new Map<string, LoadedPluginInfo>()
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
    this.compiledLoader = options?.compiledLoader ?? new CompiledLoader({
      monitorRegistry: this.monitorRegistry,
      executorRegistry: this.executorRegistry,
      strategyRegistry: this.strategyRegistry,
      ...(options?.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
      registerStrategy: (definition, factory) => this.registerStrategy(definition, factory),
    })

    // LLM keys are framework infrastructure (this.llm / the AI compiler), not
    // domain vocabulary — the runtime registers their credential types itself.
    for (const type of llmCredentialTypes) this.registerCredentialType(type)

    this.credentialStore = options?.credentialStore
    this.adapterRegistry = new AdapterRegistry(options?.credentialStore)
    this.accountStore = this.database ? new DBAccountStore(this.database) : new MemoryAccountStore()
    this.accountSnapshots = this.database ? new DBAccountSnapshotStore(this.database) : new MemoryAccountSnapshotStore()
    this.accountSnapshotIntervalMs = options?.accountSnapshots?.intervalMs ?? 5 * 60_000
    this.accountSnapshotRetentionMs = options?.accountSnapshots?.retentionMs ?? 30 * 24 * 3_600_000
    this.monitorInstances = new MonitorInstanceManager({
      store: this.database ? new DBMonitorInstanceStore(this.database) : new MemoryMonitorInstanceStore(),
      adapters: this.adapterRegistry,
      ...(this.credentialStore ? { credentials: this.credentialStore } : {}),
      dataDir: this.dataDir,
      allowsRaw: (type) => this.credentialTypes.get(type)?.raw === true,
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMonitor(definition: MonitorDefinition, instance: BaseMonitor<string, any>): void {
    const keySchema = instance.keySchema
    this.monitorRegistry.register({
      ...definition,
      ...(definition.keyFields || !keySchema
        ? {}
        : { keyFields: BaseStrategyClass.deriveParamFields(keySchema, z.object({})) ?? [] }),
    }, instance)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerExecutor(definition: ExecutorDefinition, instance: BaseExecutor<any>): void {
    this.executorRegistry.register(definition, instance)
    // Late-bound closure: pnlService exists only after start() on DB-backed
    // runtimes; executors registered earlier still pick it up. Optional call —
    // executors compiled against an older base class must keep loading.
    instance.setClaimSink?.((claim) => { void this.pnlService?.recordClaim(claim) })
    // Hot install/replace while running: boot-time startInner won't run again,
    // so the NEW executor object must take over the queue consumer here — and
    // any consumer loop still owned by a replaced object must stop first
    // (its materialized slots are stale; letting it claim instructions yields
    // "No credentials materialized" on the next execution).
    if (this.running) {
      this.queue.cancelConsumers?.(definition.id)
      void instance.run(this.queue, definition.id)
    }
  }

  registerStrategy(definition: StrategyDefinition, factory: () => IStrategy): void {
    // The strategy class's declarations are the single source of truth for its
    // dependencies and params UI. Derive the definition's derived fields from a
    // probe instance so hand-written definitions can't drift from the class.
    const probe = factory()
    if (!probe.strategyId) {
      throw new Error(
        `Strategy "${definition.id}" has no strategyId — set it with ` +
        `\`readonly strategyId = '...'\` or the @Strategy('...') decorator`
      )
    }
    for (const slot of probe.accounts) {
      if (!slot.account.kind) {
        throw new Error(
          `Strategy "${definition.id}" account slot '${slot.label}': Reader class has no kind — ` +
          `set it with \`static readonly kind = 'ns/name'\` or the @Kind('ns/name') decorator`
        )
      }
    }
    const complete: StrategyDefinition = {
      ...definition,
      monitorIds: definition.monitorIds
        ?? probe.monitors.map(d => resolveComponentName(declarationName(d), definition.pluginName)),
      executorIds: definition.executorIds
        ?? probe.executors.map(d => resolveComponentName(declarationName(d), definition.pluginName)),
      accountRequirements: definition.accountRequirements
        ?? probe.accounts.map(slot => ({
          label: slot.label,
          kind: slot.account.kind!,   // presence checked above
          ...(slot.account.venueType !== undefined ? { type: slot.account.venueType } : {}),
        })),
      llmRequirements: definition.llmRequirements
        ?? probe.llms.map(d => ({ ...d })),
      ...(definition.paramsFields || !probe.paramsFields?.length ? {} : { paramsFields: probe.paramsFields }),
      ...(definition.paramsIllustrations || !probe.paramsIllustrations?.length ? {} : { paramsIllustrations: probe.paramsIllustrations }),
    }
    this.strategyRegistry.register(complete, factory)
  }

  /** Register a credential type — the recipe for one venue/service (schema, test, raw opt-in). */
  registerCredentialType(definition: CredentialTypeDefinition, owner = 'core'): void {
    for (const kind of Object.keys(definition.factories ?? {})) {
      // Format check only: kinds have no registry to check against — the
      // vocabulary is derived from the matrix, and a typo'd kind surfaces at
      // the use site with a "no adapter for kind" error.
      assertNamespacedKind(kind)
    }
    /* Credential types are global by name — a venue's key type is meant to be
       shared, so it is deliberately NOT namespaced. That makes a second plugin
       claiming the same type an overwrite, and a silent one: every account
       bound to it would quietly start materializing through the newcomer's
       schema. Adapter cells have thrown on this for the same reason; this is
       the same rule, applied where it was missing. */
    const incumbent = this.credentialTypeOwners.get(definition.type)
    if (incumbent !== undefined && incumbent !== owner) {
      throw new Error(
        `Credential type "${definition.type}" is already registered by ${incumbent === 'core' ? 'the engine' : `plugin "${incumbent}"`}. ` +
          'Credential types are shared by name rather than namespaced, so only one plugin can define each — ' +
          'these two cannot both be installed.',
      )
    }
    this.credentialTypes.set(definition.type, definition)
    this.credentialTypeOwners.set(definition.type, owner)
  }

  listCredentialTypes(): CredentialTypeDefinition[] {
    return Array.from(this.credentialTypes.values())
  }

  // ── Monitor implementations & instances (contract / implementation / instance) ──

  /**
   * Register a monitor implementation. Its contract's façade enters the
   * monitor registry (that's what triggers and the dashboard address); user-
   * created instances of the implementation do the actual listening.
   */
  /** @returns the contract facade this call created, if it created one — the
   *  only piece a rollback may take back, since an existing facade belongs to
   *  whoever registered the first implementation of that contract. */
  registerMonitorImplementation(owner: string, impl: MonitorImplementation): string | undefined {
    const facade = this.monitorInstances.registerImplementation(owner, impl)
    const contractId = impl.contract.includes('/') ? impl.contract : `${owner}/${impl.contract}`
    let created: string | undefined
    if (!this.monitorRegistry.get(contractId)) {
      created = contractId
      const now = new Date().toISOString()
      this.registerMonitor({
        id: contractId,
        name: impl.displayName ?? contractId,
        ...(impl.description !== undefined ? { description: impl.description } : {}),
        source: 'plugin',
        pluginName: owner,
        createdAt: now,
        updatedAt: now,
      }, facade)
    }
    // Hot-installed plugins (runtime already up) get their default instances
    // immediately — boot-time restore() won't run again until the next start.
    // restore() is idempotent: existing instances/actives are skipped.
    if (this.running) void this.monitorInstances.restore()
    return created
  }

  listMonitorImplementations(): Array<ReturnType<MonitorInstanceManager['listImplementations']>[number] & { paramsFields?: import('../types/definition.js').ParamFieldDef[] }> {
    return this.monitorInstances.listImplementations().map((impl) => {
      const schema = this.monitorInstances.paramsSchemaOf(impl.id)
      const fields = schema ? BaseStrategyClass.deriveParamFields(schema, z.object({})) : undefined
      return { ...impl, ...(fields?.length ? { paramsFields: fields } : {}) }
    })
  }

  createMonitorInstance(input: { implementation: string; name?: string; credential?: string; params?: Record<string, unknown> }): Promise<MonitorInstanceEntity> {
    return this.monitorInstances.createInstance(input)
  }

  /** Update an instance's tuning params; an active one is rebuilt around the edit. */
  updateMonitorInstanceParams(id: string, params: Record<string, unknown>): Promise<void> {
    return this.monitorInstances.updateInstanceParams(id, params)
  }

  activateMonitorInstance(id: string): Promise<void> {
    return this.monitorInstances.activate(id)
  }

  deactivateMonitorInstance(id: string): Promise<void> {
    return this.monitorInstances.deactivate(id)
  }

  deleteMonitorInstance(id: string): Promise<void> {
    return this.monitorInstances.deleteInstance(id)
  }

  async listMonitorInstances(): Promise<MonitorInstanceView[]> {
    const views = await this.monitorInstances.listInstances()
    return views.map((view) => {
      const schema = this.monitorInstances.paramsSchemaOf(view.implementation)
      const fields = schema ? BaseStrategyClass.deriveParamFields(schema, z.object({})) : undefined
      return { ...view, ...(fields?.length ? { paramsFields: fields } : {}) }
    })
  }

  /** Subscribed keys no active monitor instance serves — dashboard "missing instance" hints. */
  monitorPendingKeys(): Record<string, string[]> {
    return this.monitorInstances.pendingByContract()
  }

  /** A monitor's dashboard panels (metadata only — extract stays server-side). */
  monitorPlots(monitorId: string): import('../types/monitor.js').MonitorPlotInfo[] {
    const monitor = this.monitorRegistry.get(monitorId)
    if (!monitor) return []
    return monitor.plots().map(({ id, title, kind, unit, xKind, xUnit, description, multi, columns }) => ({
      id, title, kind,
      ...(columns !== undefined ? { columns } : {}),
      ...(unit !== undefined ? { unit } : {}),
      ...(xKind !== undefined ? { xKind } : {}),
      ...(xUnit !== undefined ? { xUnit } : {}),
      ...(description !== undefined ? { description } : {}),
      // The dashboard picks its control from this before any series load
      ...(multi ? { multi: true as const } : {}),
    }))
  }

  /** Run one panel's server-side curation over the key's record tail. */
  async monitorPlotSeries(monitorId: string, plotId: string, key: string, n = 500, option?: string | string[]): Promise<{
    plot: import('../types/monitor.js').MonitorPlotInfo
    series: import('../types/monitor.js').PlotSeries[]
    options?: import('../types/monitor.js').PlotOption[]
    option?: string | string[]
  }> {
    const monitor = this.monitorRegistry.get(monitorId)
    if (!monitor) throw new Error(`Unknown monitor "${monitorId}"`)
    const def = monitor.plots().find(p => p.id === plotId)
    if (!def) throw new Error(`Monitor "${monitorId}" has no plot "${plotId}"`)
    // n <= 0 is "the whole history" — panels that fit over months of data
    // must not be silently windowed by a transport default. EXCEPT on stores
    // too large to slurp: a display request must never scan 100MB+ per panel
    // per filter click (the 2026-07-31 settlement-board freeze), so "all"
    // degrades to the newest PLOT_CAP records there — served from the tail
    // cache, so filter clicks are instant.
    const reader = monitor.getReader()
    const PLOT_CAP = 1_000
    const effectiveN = n > 0 ? n : (await reader.isOversized?.(key)) ? PLOT_CAP : 0
    const records = effectiveN > 0 ? await reader.readLast(key, effectiveN) : await reader.readAll(key)
    const options = def.options?.(records)
    // The option list is derived from the CURRENT window, so a stale pick
    // (a session that scrolled out, a token no longer sampled) must not reach
    // extract — resolve every request against what exists right now.
    const selected = resolvePlotSelection(options, option, def.multi === true)
    return {
      plot: {
        id: def.id, title: def.title, kind: def.kind,
        ...(def.unit !== undefined ? { unit: def.unit } : {}),
        ...(def.xKind !== undefined ? { xKind: def.xKind } : {}),
        ...(def.xUnit !== undefined ? { xUnit: def.xUnit } : {}),
        ...(def.description !== undefined ? { description: def.description } : {}),
        ...(def.multi ? { multi: true } : {}),
      },
      // resolvePlotSelection returns the shape this def's `multi` flag
      // declares — the union can't express that dependency at the call site.
      series: (def.extract as (r: typeof records, o?: string | string[]) => import('../types/monitor.js').PlotSeries[])(records, selected),
      ...(options !== undefined ? { options } : {}),
      ...(selected !== undefined ? { option: selected } : {}),
    }
  }

  // ── Accounts (first-class entities) ────────────────────────────────────────
  //
  // implementation × credential → a live venue account. Strategies read
  // accounts (structurally read-only view), executors write them (full body);
  // the credential is just the key that opens one.

  /** Register an account implementation. Called by loadPlugin for the plugin's `accounts` entries. */
  registerAccountImplementation(owner: string, impl: AccountImplementation): void {
    assertNamespacedKind(impl.kind)
    const id = impl.id.includes('/') ? impl.id : `${owner}/${impl.id}`
    if (this.accountImpls.has(id)) {
      throw new Error(`Account implementation "${id}" is already registered`)
    }
    this.accountImpls.set(id, { impl: { ...impl, id }, owner })
  }

  /** Implementations compatible with the given filters (dashboard implementation picker). */
  listAccountImplementations(filter?: { kind?: NamespacedKind; type?: string }): AccountImplementationInfo[] {
    return Array.from(this.accountImpls.values())
      .filter(({ impl }) => {
        if (filter?.kind !== undefined && impl.kind !== filter.kind) return false
        // A kind-generic impl (no venue) is compatible with every venue; a
        // specialized impl only with its own.
        const venue = implementationVenue(impl)
        if (filter?.type !== undefined && venue !== undefined && venue !== filter.type) return false
        return true
      })
      .map(({ impl, owner }) => {
        const venue = implementationVenue(impl)
        const accepted = venue !== undefined ? this.adapterRegistry.acceptedCredentialTypes(impl.kind, venue) : undefined
        const paramsFields = impl.paramsSchema
          ? BaseStrategyClass.deriveParamFields(impl.paramsSchema, z.object({}))
          : undefined
        return {
          id: impl.id,
          ...(impl.displayName !== undefined ? { displayName: impl.displayName } : {}),
          kind: impl.kind,
          ...(venue !== undefined ? { type: venue } : {}),
          ...(accepted !== undefined ? { credentialTypes: accepted } : {}),
          ...(impl.logo !== undefined ? { logo: impl.logo } : {}),
          ...(impl.icon !== undefined ? { icon: impl.icon } : {}),
          pluginName: owner,
          ...(paramsFields !== undefined ? { paramsFields } : {}),
        }
      })
  }

  /** Create (or update the binding of) an account entity, validating impl/credential compatibility. */
  async saveAccount(input: { name: string; implementation: string; credential?: string; params?: Record<string, unknown> }): Promise<AccountEntity> {
    const impl = this.accountImpls.get(input.implementation)?.impl
    if (!impl) {
      throw new Error(`Unknown account implementation "${input.implementation}" — is its plugin loaded?`)
    }
    const venue = implementationVenue(impl)
    if (input.credential !== undefined) {
      const { type } = await this.readCredential(input.credential)
      if (venue !== undefined) {
        // Venue-pinned impl: the (kind, venue) cell decides which credential
        // types open it; a cell-less pin falls back to venue === type (legacy
        // per-credential-type factories).
        const ok = this.adapterRegistry.acceptedCredentialTypes(impl.kind, venue) ?? [venue]
        if (!ok.includes(type)) {
          throw new Error(
            `Account "${input.name}": implementation "${impl.id}" is pinned to venue "${venue}" ` +
            `which accepts ${ok.map(t => `"${t}"`).join('/')} credentials, but "${input.credential}" has type "${type}"`
          )
        }
      } else {
        // Kind-generic impls need the credential's venue to actually open this kind
        const legacyFactories = this.credentialTypes.get(type)?.factories as Record<string, unknown> | undefined
        if (!this.adapterRegistry.has(impl.kind, type) && !legacyFactories?.[impl.kind]) {
          throw new Error(
            `Account "${input.name}": credential type "${type}" has no adapter for kind "${impl.kind}"`
          )
        }
      }
    }
    let params: Record<string, unknown> | undefined
    if (impl.paramsSchema) {
      const parsed = impl.paramsSchema.safeParse(input.params ?? {})
      if (!parsed.success) {
        throw new Error(`Account "${input.name}": invalid params — ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      }
      params = parsed.data as Record<string, unknown>
    }
    const existing = await this.accountStore.get(input.name)
    const now = new Date().toISOString()
    const entity: AccountEntity = {
      name: input.name,
      implementation: impl.id,
      ...(input.credential !== undefined ? { credential: input.credential } : {}),
      ...(params !== undefined ? { params } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await this.accountStore.save(entity)
    return entity
  }

  /** Accounts with derived kind/type/status (dashboard Accounts page). */
  async listAccounts(): Promise<AccountView[]> {
    const entities = await this.accountStore.list()
    const views: AccountView[] = []
    for (const entity of entities) {
      const impl = this.accountImpls.get(entity.implementation)?.impl
      if (!impl) {
        views.push({ ...entity, status: 'broken', problem: `implementation "${entity.implementation}" is not registered` })
        continue
      }
      if (!entity.credential) {
        const implVenue = implementationVenue(impl)
        views.push({ ...entity, kind: impl.kind, ...(implVenue !== undefined ? { type: implVenue } : {}), status: 'inactive' })
        continue
      }
      try {
        const { type } = await this.readCredential(entity.credential)
        const snapshotError = this.accountSnapshotErrors.get(entity.name)
        views.push({ ...entity, kind: impl.kind, type, status: 'ready', ...(snapshotError !== undefined ? { snapshotError } : {}) })
      } catch {
        views.push({ ...entity, kind: impl.kind, status: 'broken', problem: `credential "${entity.credential}" not found` })
      }
    }
    return views
  }

  async getAccount(name: string): Promise<AccountEntity | null> {
    return this.accountStore.get(name)
  }

  /** Ascending equity series for one account (Accounts page curve). */
  accountEquitySeries(name: string, sinceMs: number): Promise<AccountSnapshotRecord[]> {
    return this.accountSnapshots.series(name, sinceMs)
  }

  /** Drop one account's snapshot history (e.g. samples taken under a wrong equity recipe). */
  clearAccountSnapshots(name: string): Promise<void> {
    return this.accountSnapshots.clear(name)
  }

  /**
   * Live detail of one account through its READ VIEW — the curation follows
   * the kind naturally: whatever read methods the view exposes (balance /
   * positions / orders by convention) are called, each section failing
   * independently. Core stays domain-clean: results are opaque JSON.
   */
  async accountDetail(name: string): Promise<{ sections: Record<string, unknown>; errors: Record<string, string>; layout?: import('../types/account.js').AccountSectionDef[] }> {
    const entity = await this.accountStore.get(name)
    if (!entity) throw new Error(`Unknown account "${name}"`)
    if (!entity.credential) throw new Error(`Account "${name}" has no credential bound`)
    const impl = this.accountImpls.get(entity.implementation)?.impl
    if (!impl) throw new Error(`Account "${name}" uses unregistered implementation "${entity.implementation}"`)

    const { type } = await this.readCredential(entity.credential)
    const venue = implementationVenue(impl) ?? type
    const session = await this.adapterRegistry.resolve(impl.kind, venue, entity.credential)
    const reader = impl.createReader(session, entity.name, entity.params) as Record<string, unknown>

    const sections: Record<string, unknown> = {}
    const errors: Record<string, string> = {}
    // A declared layout names the read methods; without one, the perp/spot
    // convention (balance / positions / orders) is what the page knows.
    const methods = impl.sections ? Array.from(new Set(impl.sections.map(sec => sec.method))) : ['balance', 'positions', 'orders']
    await Promise.all(methods.map(async (section) => {
      const fn = reader[section]
      if (typeof fn !== 'function') return
      try {
        sections[section] = await (fn as () => Promise<unknown>).call(reader)
      } catch (err) {
        errors[section] = err instanceof Error ? err.message : String(err)
      }
    }))
    return { sections, errors, ...(impl.sections ? { layout: impl.sections } : {}) }
  }

  /** Most recent snapshot per account, keyed by account name. */
  async latestAccountSnapshots(): Promise<Record<string, AccountSnapshotRecord>> {
    const records = await this.accountSnapshots.latest()
    return Object.fromEntries(records.map(r => [r.account, r]))
  }

  /**
   * Sample every ready account whose read view implements `snapshot()` —
   * equity is a READ, so the capability lives on the read view; views without
   * it are skipped silently. Per-account failures log and continue.
   */
  async snapshotAccounts(): Promise<void> {
    const now = Date.now()
    for (const entity of await this.accountStore.list()) {
      if (!entity.credential) continue
      const impl = this.accountImpls.get(entity.implementation)?.impl
      if (!impl) continue
      try {
        const { type } = await this.readCredential(entity.credential)
        const venue = implementationVenue(impl) ?? type
        const session = await this.adapterRegistry.resolve(impl.kind, venue, entity.credential)
        const reader = impl.createReader(session, entity.name, entity.params) as { snapshot?: () => Promise<AccountSnapshotSample> }
        if (typeof reader.snapshot !== 'function') continue
        const sample = await reader.snapshot()
        await this.accountSnapshots.append({ account: entity.name, ts: now, ...sample })
        this.accountSnapshotErrors.delete(entity.name)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.accountSnapshotErrors.set(entity.name, message)
        log.warn({ account: entity.name, err }, 'Account snapshot failed — skipping this round')
      }
    }
    await this.accountSnapshots.prune(now - this.accountSnapshotRetentionMs)
  }

  /** Delete an account. Refuses while any active instance binds it. */
  async deleteAccount(name: string): Promise<void> {
    for (const instance of this.instances.values()) {
      const bound = [
        ...Object.values(instance.credentials ?? {}),
        ...(instance.accounts ?? []),
      ]
      if (bound.includes(name)) {
        throw new Error(`Cannot delete account "${name}": active instance "${instance.id}" binds it — deactivate first`)
      }
    }
    await this.accountStore.delete(name)
  }

  // ── Introspection (dashboard / AI compiler) ────────────────────────────────

  /** Registered monitor instance by registry key — for schema/source introspection. */
  /** The live strategy object behind an ACTIVE instance; undefined when deactivated. */
  getStrategy(instanceId: string): unknown {
    return this.triggerManager.getStrategy(instanceId)
  }

  /** Current strategy-owned portfolio projection for an active instance. */
  async instancePortfolio(instanceId: string): Promise<import('../types/strategy.js').StrategyPortfolioSnapshot | undefined> {
    return this.triggerManager.getStrategy(instanceId)?.getPortfolioSnapshot?.()
  }

  /** Historical portfolio report for paper or live strategy projections. */
  async instancePortfolioReport(instanceId: string, query?: PortfolioReportQuery): Promise<PortfolioReport | undefined> {
    if (!this.database) return undefined
    const journal = new PortfolioJournal(instanceId, this.database)
    const current = await this.triggerManager.getStrategy(instanceId)?.getPortfolioUpdate?.()
    if (current) await journal.commit(current)
    return journal.report(query)
  }

  /** Persisted run traces (newest first) — survive deactivation and restarts. */
  readInstanceRuns(instanceId: string, limit = 100): Promise<StrategyRunTrace[]> {
    return readRunTraces(this.dataDir, instanceId, limit)
  }

  /** Runs and instructions since `since`, summed across every instance. */
  async countRuns(since: number): Promise<{ runs: number; instructions: number }> {
    const per = await Promise.all(
      (await this.listInstanceViews()).map(v => countRunsSince(this.dataDir, v.id, since)),
    )
    return per.reduce((acc, r) => ({ runs: acc.runs + r.runs, instructions: acc.instructions + r.instructions }),
      { runs: 0, instructions: 0 })
  }

  // ── PnL attribution ─────────────────────────────────────────────────────────

  private pnlService: PnlService | undefined

  /** Per-instance realized PnL / fees / funding summary from the attribution ledger. */
  async instancePnl(instanceId: string): Promise<PnlSummary> {
    if (!this.pnlService) throw new Error('PnL attribution requires a database-backed runtime')
    return this.pnlService.instancePnl(instanceId)
  }

  /** Net totals for every instance at once — powers the list-page badges. */
  async allInstancePnl(): Promise<Record<string, { realized: number; fees: number; funding: number; net: number; unrealized: number | null }>> {
    if (!this.pnlService) return {}
    return this.pnlService.allInstanceTotals()
  }

  /** The realized-PnL curve behind an instance's number. */
  async instancePnlSeries(instanceId: string, maxPoints = 120): Promise<PnlSeriesPoint[]> {
    if (!this.pnlService) throw new Error('PnL attribution requires a database-backed runtime')
    return this.pnlService.instanceSeries(instanceId, maxPoints)
  }

  async instanceFills(instanceId: string, limit = 200): Promise<PnlFillRow[]> {
    if (!this.pnlService) throw new Error('PnL attribution requires a database-backed runtime')
    return this.pnlService.instanceFills(instanceId, limit)
  }

  async instancePositions(instanceId: string): Promise<PnlPositionRow[]> {
    if (!this.pnlService) throw new Error('PnL attribution requires a database-backed runtime')
    return this.pnlService.instancePositions(instanceId)
  }

  /** Force a collection pass now (dashboard refresh button). */
  async collectPnlNow(): Promise<void> {
    await this.pnlService?.collect()
  }

  // ── Scripts — on-demand plugin utilities ─────────────────────────────────────

  private readonly scriptRegistry = new Map<string, { def: ScriptDefinition; owner: string }>()

  async listScripts(): Promise<ScriptInfo[]> {
    const out: ScriptInfo[] = []
    for (const { def, owner } of this.scriptRegistry.values()) {
      let fields = def.paramsSchema !== undefined
        ? BaseStrategy.deriveParamFields(def.paramsSchema, z.object({})) ?? []
        : []
      // Live options (instance ids, account names) resolve per listing so the
      // dropdown always reflects the current world. A resolver failure only
      // costs the dropdown — the field degrades to a text input.
      if (def.paramOptions !== undefined) {
        try {
          const resolved = await def.paramOptions(this)
          fields = fields.map(f => resolved[f.name] !== undefined
            ? { ...f, type: 'options' as const, options: resolved[f.name]!.map(o => ({ value: o.value, label: o.label })) }
            : f)
        } catch { /* advisory */ }
      }
      out.push({
        id: def.id, name: def.name, pluginName: owner,
        ...(def.description !== undefined ? { description: def.description } : {}),
        ...(fields.length > 0 ? { paramsFields: fields } : {}),
      })
    }
    return out
  }

  /** Validate params against the script's schema and run it against this runtime. */
  async runScript(
    id: string,
    params: Record<string, unknown>,
    emit?: (line: string) => void,
    signal?: AbortSignal,
  ): Promise<ScriptResult> {
    const rec = this.scriptRegistry.get(id)
    if (!rec) throw new Error(`Unknown script: "${id}"`)
    const parsed = rec.def.paramsSchema !== undefined
      ? rec.def.paramsSchema.parse(params) as Record<string, unknown>
      : {}
    return rec.def.run({ params: parsed, runtime: this, ...(emit ? { emit } : {}), ...(signal ? { signal } : {}) })
  }

  /** The monitors an instance consumes and the executors it fires — its event scope. */
  instanceScope(instanceId: string): { monitors: Array<{ monitor: string; key: string }>; executors: string[] } {
    return {
      monitors: this.triggerManager.getMonitorScope(instanceId),
      executors: this.triggerManager.getExecutorKeys(instanceId),
    }
  }

  getMonitorInstance(id: string): BaseMonitor | undefined {
    return this.monitorRegistry.get(id)
  }

  /** Registered executor instance by registry key — for schema/source introspection. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getExecutorInstance(id: string): BaseExecutor<any> | undefined {
    return this.executorRegistry.get(id)
  }

  /**
   * The kind vocabulary — DERIVED, never declared: a kind exists iff some
   * adapter cell or account implementation claims it.
   */
  listKinds(): NamespacedKind[] {
    const kinds = new Set<NamespacedKind>(this.adapterRegistry.allKinds())
    for (const { impl } of this.accountImpls.values()) kinds.add(impl.kind)
    return Array.from(kinds)
  }

  /**
   * Fresh mock adapter + the kind-generic account implementation's read view —
   * the AI compiler's dry-run harness. Mocks are ordinary cells with
   * type 'mock' (the domain package contributes them); fresh per call so
   * dry-runs never share state. Undefined when either half is missing.
   */
  createDryRunReader(kind: NamespacedKind): unknown | undefined {
    const mockFactory = this.adapterRegistry.factoryFor(kind, 'mock')
    if (!mockFactory) return undefined
    const readerFactory = this.readerFactoryForKind(kind)
    if (!readerFactory) return undefined
    return readerFactory(mockFactory(), 'dry-run')
  }

  /** The kind-generic account implementation's reader factory (venue-specialized wins when typed). */
  private readerFactoryForKind(kind: NamespacedKind, credentialType?: string): ((session: unknown, name: string) => unknown) | undefined {
    let generic: AccountImplementation | undefined
    for (const { impl } of this.accountImpls.values()) {
      if (impl.kind !== kind) continue
      if (credentialType !== undefined && implementationVenue(impl) === credentialType) {
        return (session, name) => impl.createReader(session, name)
      }
      if (implementationVenue(impl) === undefined) generic = generic ?? impl
    }
    return generic ? (session, name) => generic!.createReader(session, name) : undefined
  }

  /** The runtime's CompiledLoader — hot-compile registration path (dashboard, AI compiler). */
  getCompiledLoader(): CompiledLoader {
    return this.compiledLoader
  }

  /**
   * The NON-SECRET fields of a stored credential, for display and editing.
   * Secrecy comes from the credential type's schema: fields with
   * `.meta({ password: true })` are withheld; types without a schema reveal
   * nothing (fail closed). Storage stays fully encrypted either way — this
   * governs what leaves the runtime, not how data rests.
   */
  async getCredentialPublicData(name: string): Promise<Record<string, unknown>> {
    const { type, data } = await this.readCredential(name)
    const schema = this.credentialTypes.get(type)?.schema
    if (!schema) return {}
    const out: Record<string, unknown> = {}
    for (const [key, field] of Object.entries(schema.shape)) {
      const meta = (field as { meta?: () => Record<string, unknown> | undefined }).meta?.()
      if (meta?.['password'] === true) continue
      if (key in data) out[key] = data[key]
    }
    return out
  }

  /**
   * Manually fire ONE instruction at an executor (dashboard console) —
   * bypasses the queue but keeps the executor's full validation/retry/
   * recording path. Credential slots are materialized just for this call
   * from the given slot-label → credential-name map and released after.
   *
   * ⚠️ This performs the executor's REAL side effects (orders, messages…).
   */
  async fireInstruction(
    executorId: string,
    action: string,
    params: Record<string, unknown>,
    credentials: Record<string, string> = {},
  ): Promise<unknown> {
    const executor = this.executorRegistry.get(executorId)
    if (!executor) throw new Error(`Unknown executor "${executorId}"`)

    const manualId = generateId('manual')
    try {
      if (executor.credentials.length > 0) {
        const slots: MaterializedSlot[] = []
        for (const decl of executor.credentials) {
          const name = credentials[decl.label]
          if (!name) throw new Error(`Credential slot '${decl.label}' requires a credential (pass credentials['${decl.label}'])`)
          if ('raw' in decl) {
            const { type, data } = await this.readCredential(name)
            if (decl.type !== type) throw new Error(`Slot '${decl.label}' requires a "${decl.type}" credential, but "${name}" is "${type}"`)
            if (!this.credentialTypes.get(type)?.raw) throw new Error(`Credential type "${type}" does not allow raw materialization`)
            slots.push({ label: decl.label, credentialName: name, raw: data })
          } else {
            // Account slots take an ACCOUNT name (venue-pinned accounts resolve
            // through their cell) — bare credential names stay accepted.
            const resolved = await this.resolveAccountBinding(name, {
              kind: decl.kind,
              ...(decl.type !== undefined ? { venueType: decl.type } : {}),
              context: `Manual fire of "${executorId}", slot '${decl.label}'`,
            })
            const session = await this.ensureSession(manualId, resolved.credentialName, resolved.type, decl.kind, resolved.data, resolved.venue)
            slots.push({ label: decl.label, credentialName: resolved.credentialName, session })
          }
        }
        executor.setMaterialized(manualId, slots)
      }

      const instruction = {
        executorId,
        messageId: manualId,
        action,
        params,
        instanceId: manualId,
      }
      return await executor.fire(instruction)
    } finally {
      executor.removeMaterialized(manualId)
      for (const [key, entry] of this.sessions) {
        if (!entry.instances.delete(manualId)) continue
        if (entry.instances.size > 0) continue
        this.sessions.delete(key)
        await this.closeSessionSafe(key, entry.session)
      }
    }
  }

  /** Serializable credential-type views — schemas exported as JSON Schema for remote form rendering. */
  describeCredentialTypes(): CredentialTypeInfo[] {
    return this.listCredentialTypes().map((def) => {
      // A type's column set comes from its adapter cells (legacy factories merged until migration completes)
      const kinds = Array.from(new Set([
        ...this.adapterRegistry.kindsForType(def.type),
        ...Object.keys(def.factories ?? {}) as NamespacedKind[],
      ]))
      return {
      type: def.type,
      ...(def.displayName !== undefined ? { displayName: def.displayName } : {}),
      ...(def.category !== undefined ? { category: def.category } : {}),
      ...(def.logo !== undefined ? { logo: def.logo } : {}),
      ...(def.icon !== undefined ? { icon: def.icon } : {}),
      ...(def.description !== undefined ? { description: def.description } : {}),
      pluginName: this.credentialTypeOwners.get(def.type) ?? 'core',
      ...(def.documentationUrl !== undefined ? { documentationUrl: def.documentationUrl } : {}),
      kinds,
      ...(def.raw !== undefined ? { raw: def.raw } : {}),
      ...(def.managed !== undefined ? { managed: def.managed } : {}),
      hasTest: typeof def.test === 'function',
      // JSON round-trip: z.toJSONSchema emits null-prototype nodes, which are
      // not "plain objects" to consumers like Next.js RSC serialization.
      ...(def.schema ? { jsonSchema: JSON.parse(JSON.stringify(z.toJSONSchema(def.schema))) as Record<string, unknown> } : {}),
      }
    })
  }

  /**
   * Run a credential type's connectivity probe against candidate data
   * (dashboard "Test" button). Validates against the schema first when one is
   * registered. Throws on failure; resolves on success.
   */
  async testCredential(type: string, data: RawCredentialData): Promise<void> {
    const def = this.credentialTypes.get(type)
    if (!def) throw new Error(`Unknown credential type "${type}"`)
    const parsed = def.schema ? (def.schema.parse(data) as RawCredentialData) : data
    if (!def.test) throw new Error(`Credential type "${type}" has no test`)
    await def.test(parsed)
  }

  loadPlugin<TConfig>(factory: PluginFactory<TConfig>, config: TConfig, opts?: PluginLoadOptions): string {
    const plugin = this.buildPlugin(factory, config)
    const ns = resolveNamespace(plugin, opts)
    if (this.loadedPlugins.has(ns)) {
      throw new PluginAlreadyLoadedError(ns, plugin.name, this.conflictingGlobals(plugin))
    }
    return this.registerPlugin(plugin, ns)
  }

  /**
   * This plugin's non-namespaced registrations that another plugin already
   * holds — the answer to "could these two be installed side by side?".
   *
   * Asked BEFORE the namespace question is put to the user, because it decides
   * whether that question has two answers or one. Offering a fresh namespace
   * to a venue plugin whose cells are taken is offering something that cannot
   * work: it would be accepted, run, and fail on the first cell it registers.
   *
   * Nothing is excluded for the incumbent, deliberately. The question is
   * whether the newcomer can live ALONGSIDE what is installed, so what the
   * incumbent holds is exactly what blocks it. (Overwriting is unaffected —
   * that unloads the incumbent first, releasing everything it held.)
   */
  private conflictingGlobals(plugin: OpenWhalePlugin): PluginGlobalConflict[] {
    const found: PluginGlobalConflict[] = []
    for (const cell of plugin.adapters ?? []) {
      const venue = cellVenue(cell)
      if (venue === undefined) continue
      const owner = this.adapterRegistry.ownerOfCell(cell.kind as NamespacedKind, venue)
      if (owner !== undefined) found.push({ what: 'adapter cell', name: `(${cell.kind}, ${venue})`, owner })
    }
    for (const type of plugin.credentialTypes ?? []) {
      const owner = this.credentialTypeOwners.get(type.type)
      if (owner !== undefined) found.push({ what: 'credential type', name: type.type, owner })
    }
    return found
  }

  /**
   * Call a plugin factory without registering what it returns.
   *
   * Split out because replacing a plugin has to know its name BEFORE it can
   * unload the one being replaced, and the name only exists once the factory
   * has run. Calling the factory twice instead would mean running a plugin's
   * setup twice per replace, which is not a factory's contract.
   */
  private buildPlugin<TConfig>(factory: PluginFactory<TConfig>, config: TConfig): OpenWhalePlugin {
    if (!this.credentialStore) {
      throw new Error('loadPlugin() requires a CredentialStore — pass one in RuntimeOptions')
    }
    return factory({ credentials: this.credentialStore, config, adapters: this.adapterRegistry, publicSessions: this.publicSessions })
  }

  /**
   * Register a plugin's contributions — all of them, or none.
   *
   * Several of these registrations refuse a name somebody else already holds
   * (adapter cells, credential types, scripts), and a plugin that trips one
   * halfway through used to leave everything before it registered with no
   * `loadedPlugins` entry to find it by — so `unloadPlugin` would answer
   * "Plugin not loaded" and the debris stayed until the engine restarted, with
   * the next attempt failing on the wreckage of the last one rather than the
   * real cause.
   *
   * Undo steps are recorded as they are earned rather than derived afterwards,
   * because "what this call registered" and "what this plugin lists" are not
   * the same set: a contract facade is created only by the FIRST
   * implementation of that contract, and taking one back on behalf of a
   * failed install would unregister a monitor another plugin is serving.
   */
  private registerPlugin(plugin: OpenWhalePlugin, ns: string): string {
    const p = (id: string) => `${ns}/${id}`
    const undo: Array<() => void> = []

    // Class entries (@OwAccount/@OwMonitor) lower to plain registrations here,
    // so plugin factories may reference classes directly, not just definePlugin.
    const accountImpls = (plugin.accounts ?? []).map(entry => lowerAccountEntry(entry, ns))
    const monitorImpls = (plugin.monitorImplementations ?? []).map(entry => lowerMonitorEntry(entry, ns))

    try {
      for (const cell of plugin.adapters ?? []) {
        assertNamespacedKind(cell.kind)
        this.adapterRegistry.register(ns, cell)
        undo.push(() => void this.adapterRegistry.unregisterOwner(ns))
      }
      // Legacy publicSessions entries become keyless-only cells (venue = plugin name)
      for (const reg of plugin.publicSessions ?? []) {
        assertNamespacedKind(reg.kind)
        this.adapterRegistry.register(ns, { kind: reg.kind, type: ns, create: () => reg.create() })
        undo.push(() => void this.adapterRegistry.unregisterOwner(ns))
      }

      for (const { definition, instance } of plugin.monitors ?? []) {
        const id = p(instance.monitorName)
        this.registerMonitor({ ...definition, id, pluginName: ns }, instance)
        undo.push(() => this.monitorRegistry.unregister(id))
      }
      for (const { definition, instance } of plugin.executors ?? []) {
        const id = p(instance.executorName)
        this.registerExecutor({ ...definition, id, pluginName: ns }, instance)
        undo.push(() => {
          this.queue.cancelConsumers?.(id)
          this.executorRegistry.unregister(id)
        })
      }
      for (const { definition, factory: sf } of plugin.strategies ?? []) {
        // pluginName carries the namespace; registerStrategy derives monitorIds/
        // executorIds from the class declarations resolved against it. The
        // strategy instance itself never learns the namespace.
        const { monitorIds: _m, executorIds: _e, ...rest } = definition
        const id = p(definition.id)
        this.registerStrategy({ ...rest, id, pluginName: ns }, sf)
        undo.push(() => this.strategyRegistry.unregister(id))
      }
      for (const credentialType of plugin.credentialTypes ?? []) {
        this.registerCredentialType(credentialType, ns)
        undo.push(() => {
          this.credentialTypes.delete(credentialType.type)
          this.credentialTypeOwners.delete(credentialType.type)
        })
      }
      for (const script of plugin.scripts ?? []) {
        const id = p(script.id)
        if (this.scriptRegistry.has(id)) throw new Error(`Script "${id}" is already registered`)
        this.scriptRegistry.set(id, { def: { ...script, id }, owner: ns })
        undo.push(() => this.scriptRegistry.delete(id))
      }
      for (const impl of accountImpls) {
        this.registerAccountImplementation(ns, impl)
        undo.push(() => this.accountImpls.delete(impl.id))
      }
      for (const impl of monitorImpls) {
        const createdFacade = this.registerMonitorImplementation(ns, impl)
        undo.push(() => {
          void this.monitorInstances.unregisterOwner(ns)
          if (createdFacade !== undefined) this.monitorRegistry.unregister(createdFacade)
        })
      }
    } catch (err) {
      // Newest first, so each step unwinds against the state it was made in
      for (const step of undo.reverse()) {
        try { step() } catch (cleanupErr) { log.warn({ plugin: ns, err: cleanupErr }, 'Rollback step failed') }
      }
      log.warn({ plugin: ns, err }, 'Plugin registration rolled back')
      throw err
    }

    this.loadedPlugins.set(ns, {
      name: ns,
      ...(plugin.name !== ns ? { declaredName: plugin.name } : {}),
      version: plugin.version,
      ...(plugin.readme !== undefined ? { readme: plugin.readme } : {}),
      ...(plugin.logo !== undefined ? { logo: plugin.logo } : {}),
      ...(plugin.icon !== undefined ? { icon: plugin.icon } : {}),
      monitors: [
        ...(plugin.monitors ?? []).map(({ instance }) => p(instance.monitorName)),
        ...Array.from(new Set(monitorImpls.map(impl => impl.contract.includes('/') ? impl.contract : p(impl.contract)))),
      ],
      executors: (plugin.executors ?? []).map(({ instance }) => p(instance.executorName)),
      strategies: (plugin.strategies ?? []).map(({ definition }) => p(definition.id)),
      accounts: accountImpls.map(impl => impl.id.includes('/') ? impl.id : p(impl.id)),
      scripts: (plugin.scripts ?? []).map(script => p(script.id)),
      kinds: Array.from(new Set([...(plugin.adapters ?? []).map(a => a.kind), ...accountImpls.map(a => a.kind)])),
      credentialTypes: (plugin.credentialTypes ?? []).map(c => c.type),
      cells: (plugin.adapters ?? []).map(cell => ({ kind: cell.kind as string, venue: cellVenue(cell) ?? '?' })),
    })
    return ns
  }

  /**
   * Load a plugin from a built JS module on disk. The module must default-export
   * a PluginFactory. Same namespacing and registration as loadPlugin().
   */
  async loadPluginFromPath(filePath: string, config: unknown, opts?: PluginLoadOptions): Promise<string> {
    return this.loadPlugin(await importPluginFactory(filePath), config, opts)
  }

  /**
   * Load a plugin over one already loaded under the same name, keeping
   * everything the user built on it.
   *
   * The opposite trade from uninstall. Uninstall means "this plugin is going
   * away", so an instance or credential left pointing at nothing is a loss and
   * it refuses. A replace means "same plugin, different code": the new version
   * almost certainly still has the strategy an instance names, so deleting the
   * instance to swap the code would destroy the very thing the swap is for.
   * Persisted rows are therefore never touched — the ones whose strategy
   * survived come back running, and any that do not are left for the user to
   * see and decide about. Reinstalling the old code makes them whole again,
   * because nothing was thrown away.
   *
   * Running instances are stopped with `releaseInstance`, not `deactivate`:
   * deactivate would persist enabled=false, which would silently turn "I
   * upgraded a plugin" into "my strategies are off after the next reboot".
   */
  async replacePluginFromPath(filePath: string, config: unknown, opts?: PluginLoadOptions): Promise<PluginReplaceResult> {
    return this.replacePlugin(await importPluginFactory(filePath), config, opts)
  }

  /** replacePluginFromPath for a factory already in hand. */
  async replacePlugin<TConfig>(factory: PluginFactory<TConfig>, config: TConfig, opts?: PluginLoadOptions): Promise<PluginReplaceResult> {
    const plugin = this.buildPlugin(factory, config)
    const ns = resolveNamespace(plugin, opts)
    const existing = this.loadedPlugins.get(ns)

    if (existing) {
      const strategies = new Set(existing.strategies)
      const live = Array.from(this.instances.values()).filter(i => strategies.has(i.strategyId)).map(i => i.id)
      for (const id of live) await this.releaseInstance(id)
      // Nothing of the plugin's is live now, so the ordinary guard is satisfied
      await this.unloadPlugin(ns)
    }
    this.registerPlugin(plugin, ns)

    /* Start everything of this plugin's that is marked enabled and is not
       already running — boot's exact rule, `enabled` meaning "should be
       running". Applying it here is what makes putting the old version back
       whole again: an instance orphaned by an earlier swap was left enabled,
       so reinstalling the code that has its strategy starts it, without the
       user having to remember which ones to switch on. */
    const provided = new Set(this.loadedPlugins.get(ns)?.strategies ?? [])
    const resumed: string[] = []
    const orphaned: string[] = []
    for (const row of await this.instanceStore.loadAll()) {
      if (!row.strategyId.startsWith(`${ns}/`)) continue    // another plugin's business
      if (!row.enabled || this.instances.has(row.id)) continue
      if (!provided.has(row.strategyId)) {
        // The row stays; listInstanceViews reports the strategy as missing
        orphaned.push(row.id)
        continue
      }
      try {
        await this.activateInstance(row, { persist: false })
        resumed.push(row.id)
      } catch (err) {
        orphaned.push(row.id)
        log.warn({ plugin: ns, instance: row.id, err }, 'Instance did not survive the plugin replacement')
      }
    }
    log.info(
      { plugin: ns, replaced: existing !== undefined, resumed: resumed.length, orphaned: orphaned.length },
      existing ? 'Plugin replaced' : 'Plugin loaded',
    )
    return { name: ns, replaced: existing !== undefined, resumed, orphaned }
  }

  /**
   * Unregister a loaded plugin's components. Refuses when any active instance
   * still uses one of the plugin's strategies — deactivate those first.
   */
  async unloadPlugin(name: string): Promise<void> {
    const plugin = this.loadedPlugins.get(name)
    if (!plugin) throw new Error(`Plugin not loaded: "${name}"`)

    const inUse = Array.from(this.instances.values()).filter(i => plugin.strategies.includes(i.strategyId))
    if (inUse.length > 0) {
      throw new Error(
        `Cannot unload plugin "${name}": ${inUse.length} active instance(s) use its strategies ` +
        `(${inUse.map(i => i.id).join(', ')}). Deactivate them first.`
      )
    }

    for (const id of plugin.monitors) this.monitorRegistry.unregister(id)
    for (const id of plugin.executors) {
      // The unregistered object's consume loop must not keep claiming the id
      this.queue.cancelConsumers?.(id)
      this.executorRegistry.unregister(id)
    }
    for (const id of plugin.strategies) this.strategyRegistry.unregister(id)
    for (const type of plugin.credentialTypes) {
      // Only what this plugin actually owns — a type it merely declared but
      // lost to an incumbent still belongs to the incumbent
      if (this.credentialTypeOwners.get(type) !== name) continue
      this.credentialTypes.delete(type)
      this.credentialTypeOwners.delete(type)
    }
    for (const [id, entry] of this.accountImpls) {
      if (entry.owner === name) this.accountImpls.delete(id)
    }
    // Scripts too — a reinstall of the same plugin otherwise dies on
    // "already registered" for its first script and leaves nothing loaded.
    for (const [id, entry] of this.scriptRegistry) {
      if (entry.owner === name) this.scriptRegistry.delete(id)
    }
    /* Awaited, not fired and forgotten. Both teardowns reach live objects —
       monitor runners to stop, sessions to close — and a replace re-registers
       the moment this returns. Letting either finish afterwards means
       registering against a registry the previous plugin has not finished
       leaving. */
    await this.monitorInstances.unregisterOwner(name)
    await this.adapterRegistry.unregisterOwner(name)
    this.loadedPlugins.delete(name)
    log.info({ plugin: name }, 'Plugin unloaded')
  }

  listLoadedPlugins(): LoadedPluginInfo[] {
    return Array.from(this.loadedPlugins.values())
  }

  /**
   * Everything still attached to a plugin — asked before uninstalling it.
   *
   * Reads the STORES, not the live maps: an instance the user deactivated
   * still holds their params, and a credential still holds their secret, so
   * both must block a removal that would orphan them. (unloadPlugin's own
   * check looks at live instances only, which is right for a hot reload and
   * far too weak for a delete.)
   *
   * A plugin that failed to load registered nothing, so nothing can be
   * attributed to it and this comes back empty — deliberately, since refusing
   * to enumerate would also be refusing to ever remove a broken plugin.
   */
  async pluginDependents(name: string): Promise<PluginDependents> {
    const plugin = this.loadedPlugins.get(name)
    if (!plugin) return { instances: [], accounts: [], credentials: [], monitorInstances: [] }

    const strategies = new Set(plugin.strategies)
    const accountImpls = new Set(plugin.accounts)
    const credentialTypes = new Set(plugin.credentialTypes)
    const monitorImpls = new Set(this.monitorInstances.implementationsOf(name))

    const [instanceViews, accounts, monitors] = await Promise.all([
      this.listInstanceViews(),
      this.listAccounts(),
      this.monitorInstances.listInstances(),
    ])
    const credentials = this.credentialStore ? await this.credentialStore.list() : []

    return {
      instances: instanceViews.filter(i => strategies.has(i.strategyId)).map(i => i.id),
      accounts: accounts.filter(a => accountImpls.has(a.implementation)).map(a => a.name),
      credentials: credentials.filter(c => credentialTypes.has(c.type)).map(c => c.name),
      monitorInstances: monitors.filter(m => monitorImpls.has(m.implementation)).map(m => m.id),
    }
  }

  addStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void {
    this.triggerManager.addStrategyRunHandler(handler)
  }

  removeStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void {
    this.triggerManager.removeStrategyRunHandler(handler)
  }

  setStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void {
    this.triggerManager.addStrategyRunHandler(handler)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      await this.startInner()
    } catch (err) {
      // Reset the guard so a failed boot can be retried instead of leaving the
      // runtime permanently half-started behind an early-return.
      this.running = false
      throw err
    }
  }

  private async startInner(): Promise<void> {
    // Initialize database schema if a database adapter is provided
    if (this.database) await this.database.initialize()

    // PnL attribution: executors claim their venue order ids; the collector
    // joins the venue's fills/funding back through the claims. Requires the
    // DB (the ledger lives there) — memory-mode runtimes skip it.
    if (this.database && !this.pnlService) {
      const db = this.database
      this.pnlService = new PnlService({
        db,
        resolveSession: async (account: string) => {
          try {
            const { type } = await this.readCredential(account)
            return await this.adapterRegistry.resolve<PnlSessionLike>('exchange/perp' as NamespacedKind, type, account)
          } catch {
            return null   // credential gone or venue lacks a perp cell — claims-only mode
          }
        },
      })
    }
    this.pnlService?.start()

    // Load compiled components
    if (this.compiledLoader) await this.compiledLoader.loadAll()

    // Monitor instances first: strategy triggers subscribing during instance
    // restore must find their serving monitors already active.
    await this.monitorInstances.restore()

    // Load and activate persisted instances. A single stale instance (e.g. its
    // strategy's params schema changed since it was saved) must not brick the
    // whole boot — skip it and keep going.
    const persistedInstances = await this.instanceStore.loadAll()
    for (const instance of persistedInstances) {
      if (this.instances.has(instance.id)) continue
      // Deactivated (enabled=false) instances stay stopped across restarts —
      // they resume only through an explicit activateById
      if (!instance.enabled) continue
      try {
        await this.activateInstance(instance, { persist: false })
      } catch (err) {
        log.error({ instanceId: instance.id, strategyId: instance.strategyId, err }, 'Failed to restore persisted instance — skipping')
      }
    }

    this.triggerManager.start(this.queue)

    // Start executors from registry
    for (const def of this.executorRegistry.list()) {
      const executor = this.executorRegistry.get(def.id)
      if (executor) void executor.run(this.queue, def.id)
    }

    // Equity snapshotter: one immediate sample (fresh curves on first paint),
    // then the interval. unref() so tests/embedders aren't kept alive by it.
    void this.snapshotAccounts()
    this.accountSnapshotTimer = setInterval(() => void this.snapshotAccounts(), this.accountSnapshotIntervalMs)
    this.accountSnapshotTimer.unref?.()
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.pnlService?.stop()
    if (this.accountSnapshotTimer) {
      clearInterval(this.accountSnapshotTimer)
      this.accountSnapshotTimer = undefined
    }
    this.triggerManager.stop()
    await this.queue.stop()
    // Release every instance so a later start() re-activates from persistence
    // with fresh accounts, instead of reusing entries whose accounts are closed.
    for (const instanceId of Array.from(this.instances.keys())) {
      await this.releaseInstance(instanceId, { closeAccounts: false })
    }
    for (const [key, entry] of this.sessions) {
      await this.closeSessionSafe(key, entry.session)
    }
    this.sessions.clear()
    await this.monitorInstances.stopAll()
    await this.adapterRegistry.closeAll()
    if (this.database) await this.database.close()
  }

  async activate(instance: StrategyInstance): Promise<void> {
    await this.activateInstance(instance, { persist: true })
  }

  /**
   * Persist an instance without starting it.
   *
   * Creating a strategy and running it are two decisions, and a strategy that
   * places orders is not one to make by accident: the params want reading
   * over, the accounts want checking, and none of that is possible once it is
   * already live. Saved stopped, it starts on an explicit activateById.
   *
   * The strategy id is checked even though nothing runs — a row naming a
   * strategy that does not exist is only discoverable at the moment someone
   * tries to start it, which is the worst time to learn it.
   */
  async saveInstance(instance: StrategyInstance): Promise<void> {
    if (this.strategyRegistry.getDefinition(instance.strategyId) === undefined) {
      throw new Error(`Unknown strategy "${instance.strategyId}" — is its plugin installed?`)
    }
    await this.instanceStore.save({ ...instance, enabled: false, updatedAt: new Date().toISOString() })
    log.info({ instance: instance.id, strategy: instance.strategyId }, 'Instance saved, not started')
  }

  /** Activate a persisted (stopped) instance by id. Idempotent when already active. */
  async activateById(instanceId: string): Promise<void> {
    if (this.instances.has(instanceId)) return
    const persisted = await this.instanceStore.load(instanceId)
    if (!persisted) throw new Error(`Unknown instance "${instanceId}"`)
    persisted.enabled = true
    persisted.updatedAt = new Date().toISOString()
    await this.activateInstance(persisted, { persist: true })
  }

  /**
   * Stop an instance but KEEP its persisted row (enabled=false so it does not
   * auto-resume on boot). Edit with updateInstance, resume with activateById,
   * remove for good with deleteInstance.
   */
  async deactivate(instanceId: string): Promise<void> {
    await this.releaseInstance(instanceId)
    const persisted = await this.instanceStore.load(instanceId)
    if (persisted) {
      persisted.enabled = false
      persisted.updatedAt = new Date().toISOString()
      await this.instanceStore.save(persisted)
    }
  }

  /** Stop (if active) and remove the persisted row. */
  async deleteInstance(instanceId: string): Promise<void> {
    await this.releaseInstance(instanceId)
    await this.instanceStore.delete(instanceId)
  }

  /**
   * Edit an instance — any field; validation happens at activation.
   *
   * A running instance refuses the edit unless `restart` is passed. The rule
   * behind that refusal is that a strategy's triggers, subscriptions and
   * executor slots are all derived from its params ONCE, at activation: an
   * instance whose stored params no longer describe the machinery actually
   * running is lying to whoever reads it next. `restart` satisfies the rule
   * instead of waiving it — the instance is rebuilt from the new params, so
   * what runs and what is stored still agree.
   */
  async updateInstance(
    instanceId: string,
    patch: Partial<Pick<StrategyInstance, 'name' | 'description' | 'credentials' | 'accounts' | 'llm' | 'params'>>,
    { restart = false }: { restart?: boolean } = {},
  ): Promise<StrategyInstance> {
    const wasActive = this.instances.has(instanceId)
    if (wasActive && !restart) {
      throw new Error(`Instance "${instanceId}" is active — deactivate it before editing`)
    }
    const persisted = await this.instanceStore.load(instanceId)
    if (!persisted) throw new Error(`Unknown instance "${instanceId}"`)
    // Snapshot BEFORE mutating: rollback needs the configuration that was
    // actually running, and `persisted` is about to become the new one.
    const previous = wasActive ? (JSON.parse(JSON.stringify(persisted)) as StrategyInstance) : undefined

    if (patch.name !== undefined) persisted.name = patch.name
    if (patch.description !== undefined) {
      if (patch.description) persisted.description = patch.description
      else delete persisted.description
    }
    if (patch.credentials !== undefined) persisted.credentials = patch.credentials
    if (patch.accounts !== undefined) persisted.accounts = patch.accounts
    if (patch.llm !== undefined) persisted.llm = patch.llm
    if (patch.params !== undefined) persisted.params = patch.params
    persisted.updatedAt = new Date().toISOString()

    if (!wasActive) {
      await this.instanceStore.save(persisted)
      return persisted
    }

    // activateInstance releases the previous registration itself and keeps the
    // accounts open, so there is no window where the instance is torn down
    // waiting on fresh venue connections — and it persists only on success.
    try {
      await this.activateInstance(persisted, { persist: true })
      return persisted
    } catch (err) {
      // The edit is rejected at activation — bad params, an unbound slot, a
      // credential that no longer resolves. Leaving it here would mean a
      // rejected edit silently STOPPED a strategy that was running fine, which
      // is a far worse outcome than the edit not applying. Put the old
      // configuration back and bring it up again.
      let restored = false
      if (previous) {
        try {
          await this.activateInstance(previous, { persist: true })
          restored = true
        } catch (rollbackErr) {
          log.error({ instanceId, err: rollbackErr }, 'Rollback failed — instance is STOPPED')
        }
      }
      const detail = err instanceof Error ? err.message : String(err)
      throw new Error(
        restored
          ? `Instance "${instanceId}" rejected the edit and was rolled back — it is still running on its previous settings. Cause: ${detail}`
          : `Instance "${instanceId}" rejected the edit AND could not be rolled back — it is now STOPPED. Cause: ${detail}`,
        { cause: err },
      )
    }
  }

  /**
   * Edit COSMETIC metadata — icon, folder, ordering, name, description. These
   * never affect a running strategy, so unlike updateInstance they are
   * allowed while the instance is active; an active in-memory copy is patched
   * in place so views agree without a restart.
   */
  async updateInstanceMeta(
    instanceId: string,
    patch: Partial<Pick<StrategyInstance, 'name' | 'description' | 'icon' | 'folder' | 'sortOrder'>>,
  ): Promise<StrategyInstance> {
    const persisted = await this.instanceStore.load(instanceId)
    if (!persisted) throw new Error(`Unknown instance "${instanceId}"`)
    const apply = (target: StrategyInstance) => {
      if (patch.name !== undefined) target.name = patch.name
      if (patch.description !== undefined) {
        if (patch.description) target.description = patch.description
        else delete target.description
      }
      if (patch.icon !== undefined) {
        if (patch.icon) target.icon = patch.icon
        else delete target.icon
      }
      if (patch.folder !== undefined) {
        if (patch.folder) target.folder = patch.folder
        else delete target.folder
      }
      if (patch.sortOrder !== undefined) target.sortOrder = patch.sortOrder
    }
    apply(persisted)
    persisted.updatedAt = new Date().toISOString()
    await this.instanceStore.save(persisted)
    const live = this.instances.get(instanceId)
    if (live) apply(live)
    return persisted
  }

  /** Copy an instance's full configuration into a new STOPPED instance. */
  async duplicateInstance(instanceId: string, name?: string): Promise<StrategyInstance> {
    const source = this.instances.get(instanceId) ?? await this.instanceStore.load(instanceId)
    if (!source) throw new Error(`Unknown instance "${instanceId}"`)
    const now = new Date().toISOString()
    const copy: StrategyInstance = {
      ...structuredClone(source),
      id: generateId('inst'),
      name: name?.trim() || `${source.name} (copy)`,
      enabled: false,
      createdAt: now,
      updatedAt: now,
    }
    await this.instanceStore.save(copy)
    return copy
  }

  /**
   * Release all runtime resources held by an instance: trigger registrations
   * (cron tasks + monitor subscriptions), executor account injections, and —
   * when closeAccounts is true and no other active instance shares them — the
   * account instances themselves. Re-activation and stop() pass
   * closeAccounts: false so shared/reusable accounts aren't bounced.
   */
  private async releaseInstance(
    instanceId: string,
    { closeAccounts = true }: { closeAccounts?: boolean } = {},
  ): Promise<void> {
    const instance = this.instances.get(instanceId)
    const executorKeys = this.triggerManager.getExecutorKeys(instanceId)

    this.triggerManager.unregisterInstance(instanceId)
    this.instances.delete(instanceId)

    for (const resolvedId of executorKeys) {
      this.executorRegistry.get(resolvedId)?.removeMaterialized(instanceId)
    }

    void instance

    // Drop this instance's session references; close sessions nobody uses
    for (const [key, entry] of this.sessions) {
      if (!entry.instances.delete(instanceId)) continue
      if (entry.instances.size > 0 || !closeAccounts) continue
      this.sessions.delete(key)
      await this.closeSessionSafe(key, entry.session)
    }
  }

  /**
   * Close a session without letting a failed close (e.g. an already-broken
   * WebSocket) abort teardown — an aborted deactivate() would leave the
   * instance persisted and it would resume trading on the next boot.
   */
  private async closeSessionSafe(key: string, session: unknown): Promise<void> {
    try {
      await (session as { close?: () => Promise<void> }).close?.()
    } catch (err) {
      log.warn({ session: key, err }, 'Session close failed — continuing teardown')
    }
  }

  listInstances(): StrategyInstance[] {
    return Array.from(this.instances.values())
  }

  /** All persisted instances merged with live activation state. */
  async listInstanceViews(): Promise<StrategyInstanceView[]> {
    const persisted = await this.instanceStore.loadAll()
    const seen = new Set<string>()
    const views: StrategyInstanceView[] = []
    for (const row of persisted) {
      const live = this.instances.get(row.id)
      views.push({ ...(live ?? row), active: live !== undefined, ...this.instanceProblem(row.strategyId) })
      seen.add(row.id)
    }
    for (const [id, live] of this.instances) {
      if (!seen.has(id)) views.push({ ...live, active: true })
    }
    return views
  }

  /** A missing strategy is the visible half of an uninstalled or replaced plugin. */
  private instanceProblem(strategyId: string): { problem?: string } {
    if (this.strategyRegistry.getDefinition(strategyId) !== undefined) return {}
    const [ns] = strategyId.split('/')
    const pluginGone = ns !== undefined && !this.loadedPlugins.has(ns)
    return {
      problem: `strategy "${strategyId}" is not registered${
        pluginGone ? ` — plugin "${ns}" is not installed` : ' — its plugin no longer provides it'
      }`,
    }
  }

  /**
   * Check a strategy param's chosen values against a venue.
   *
   * The field's `availability` marker decides how: a named `checker` the
   * strategy provides (arbitrary logic — liquidity floors, pair sanity), or
   * the built-in market check (every value, split by `separator`, must be a
   * listed symbol). Markets are read through the KEYLESS adapter cell, so the
   * check works before any credential is bound.
   *
   * Advisory by construction: a venue that publishes no catalogue yields no
   * verdicts rather than a wall of false negatives.
   */
  async checkParamAvailability(
    strategyId: string,
    fieldName: string,
    values: string[],
    venue: string,
  ): Promise<import('../types/definition.js').AvailabilityVerdict[]> {
    const definition = this.strategyRegistry.getDefinition(strategyId)
    const field = definition?.paramsFields?.find(f => f.name === fieldName)
    if (!field?.availability) throw new Error(`Field "${fieldName}" of "${strategyId}" declares no availability check`)
    const spec = field.availability
    if (values.length === 0) return []

    const kind = (spec.kind ?? 'exchange/perp') as NamespacedKind
    if (!this.adapterRegistry.has(kind, venue)) {
      throw new Error(`No "${kind}" adapter for venue "${venue}"`)
    }
    const session = await this.adapterRegistry.resolve<Record<string, unknown>>(kind, venue)
    const fetchMarkets = session['fetchMarkets']
    const markets = typeof fetchMarkets === 'function'
      ? await (fetchMarkets as () => Promise<Array<Record<string, unknown>>>).call(session)
      : []

    if (spec.checker) {
      const checker = this.strategyRegistry.get(strategyId)?.().availabilityCheckers?.[spec.checker]
      if (!checker) throw new Error(`Strategy "${strategyId}" provides no availability checker "${spec.checker}"`)
      return checker(values, { venue, markets })
    }

    // Built-in: every symbol in the value must be listed.
    if (markets.length === 0) return []
    const listed = new Set(markets.map(m => String(m['symbol'])))
    return values.map((value) => {
      const symbols = spec.separator ? value.split(spec.separator).filter(Boolean) : [value]
      const missing = symbols.filter(s => !listed.has(s))
      return missing.length === 0
        ? { value, available: true }
        : { value, available: false, reason: `${venue} does not list ${missing.join(', ')}` }
    })
  }

  listStrategies(): StrategyDefinition[] {
    return this.strategyRegistry.list()
  }

  listMonitors(): MonitorDefinition[] {
    // keyFields re-derive on every read: keySchemas contain LIVE option lists
    // (the venue dropdown queries the adapter matrix), so a registration-time
    // snapshot would freeze them at whatever plugins were loaded first.
    return this.monitorRegistry.list().map((def) => {
      const monitor = this.monitorRegistry.get(def.id)
      if (!monitor) return def
      // supportsBackfill is likewise live: a contract gains the capability as
      // soon as a backfilling implementation registers against it.
      const out = monitor.supportsBackfill ? { ...def, supportsBackfill: true } : def
      const keySchema = monitor.keySchema
      if (!keySchema) return out
      const keyFields = BaseStrategyClass.deriveParamFields(keySchema, z.object({}))
      return keyFields?.length ? { ...out, keyFields } : out
    })
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

    // Re-activation: release the previous registration first so cron tasks,
    // subscriptions, and executor accounts don't accumulate. Accounts are kept
    // open — ensureAccounts() below reuses them from the registry.
    if (this.instances.has(instance.id)) await this.releaseInstance(instance.id, { closeAccounts: false })

    const strategy = strategyFactory()
    const parsedParams = this.parseParams(strategy, instance)
    const { readers, credentialNames, accountMetas } = await this.materializeStrategySlots(instance, strategy)
    // BEFORE triggers(): venue-scoped subscriptions derive from the bound accounts
    strategy.setAccountMeta(accountMetas)

    // The strategy speaks in labels; resolve label → registry key here, once,
    // using the namespace recorded on the strategy's definition.
    const ns = this.strategyRegistry.getDefinition(instance.strategyId)?.pluginName
    const monitorLabelToKey = buildLabelToKeyMap(strategy.monitors, ns)
    const executorLabelToKey = buildLabelToKeyMap(strategy.executors, ns)

    // triggers() conditions reference monitors by label — used as-is
    const triggers = strategy.triggers(parsedParams).map((t, i) => ({
      ...t,
      id: `${instance.id}-trigger-${i}`,
      strategyInstanceId: instance.id,
    }))

    // Per-instance LLM slot overrides (model/credential/settings by label)
    strategy.setLlmBindings(instance.llm ?? {})

    // Persist finished run traces — the audit trail must outlive deactivation
    strategy.setRunSink?.(run => { void appendRunTrace(this.dataDir, instance.id, run).catch(() => {}) })

    this.instances.set(instance.id, instance)
    this.triggerManager.registerInstance(
      instance.id, strategy, triggers, parsedParams, readers, credentialNames, monitorLabelToKey, executorLabelToKey,
    )

    // Materialize each declared executor's credential slots (sessions / raw)
    await this.materializeExecutorSlots(instance, strategy, executorLabelToKey)

    if (persist) await this.instanceStore.save(instance)
  }

  private parseParams(strategy: IStrategy, instance: StrategyInstance) {
    const base = instance.params?.base ?? {}
    const tunable = instance.params?.tunable ?? {}
    // Validate base (required fields, fail at activate) and fill tunable defaults via Zod parse
    const parsedBase = strategy.baseParamsSchema.parse(base) as RawCredentialData
    const parsedTunable = strategy.tunableParamsSchema.parse(tunable) as RawCredentialData
    return { base: parsedBase, tunable: parsedTunable }
  }

  // ── Credential materialization ────────────────────────────────────────────
  //
  // The Credential is the root entity; consumers receive materializations on a
  // privilege ladder: Reader (strategies) < Session (executors) < Raw
  // (executors, explicit opt-in). Sessions are cached per credential × kind
  // and closed when no active instance references them.

  /** Resolve the credential name bound to a slot path, honoring both binding styles. */
  private boundCredential(instance: StrategyInstance, slotPath: string, positional?: string): string | undefined {
    return instance.credentials?.[slotPath] ?? positional
  }

  /**
   * Resolve a slot binding value into credential facts. The binding is an
   * ACCOUNT name first (the entity supplies implementation + credential);
   * a plain credential name is accepted as the legacy fallback and gets the
   * kind's canonical reader.
   */
  private async resolveAccountBinding(
    bindingName: string,
    opts: { kind: NamespacedKind; venueType?: string; context: string },
  ): Promise<{ credentialName: string; type: string; venue: string; data: RawCredentialData; impl?: AccountImplementation; params?: Record<string, unknown> }> {
    const entity = await this.accountStore.get(bindingName)
    if (entity) {
      const impl = this.accountImpls.get(entity.implementation)?.impl
      if (!impl) {
        throw new Error(`${opts.context}: account "${bindingName}" uses unregistered implementation "${entity.implementation}"`)
      }
      if (impl.kind !== opts.kind) {
        throw new Error(
          `${opts.context}: account "${bindingName}" has kind "${impl.kind}" but the slot requires "${opts.kind}"`
        )
      }
      if (!entity.credential) {
        throw new Error(
          `${opts.context}: account "${bindingName}" has no credential bound — bind one on the Accounts page`
        )
      }
      const { type, data } = await this.readCredential(entity.credential)
      // The account's venue: the impl's pin, or (kind-generic) the credential's type.
      const venue = implementationVenue(impl) ?? type
      const ok = this.adapterRegistry.acceptedCredentialTypes(impl.kind, venue) ?? [venue]
      if (!ok.includes(type)) {
        throw new Error(
          `${opts.context}: account "${bindingName}" is on venue "${venue}" which accepts ` +
          `${ok.map(t => `"${t}"`).join('/')} credentials, but "${entity.credential}" has type "${type}"`
        )
      }
      if (opts.venueType !== undefined && opts.venueType !== venue) {
        throw new Error(
          `${opts.context}: slot requires a "${opts.venueType}" venue, but account "${bindingName}" is "${venue}"`
        )
      }
      return { credentialName: entity.credential, type, venue, data, impl, ...(entity.params !== undefined ? { params: entity.params } : {}) }
    }

    // Legacy: the binding is a credential name (venue = the credential's type)
    const { type, data } = await this.readCredential(bindingName)
    if (opts.venueType !== undefined && opts.venueType !== type) {
      throw new Error(
        `${opts.context}: slot requires a "${opts.venueType}" credential, but "${bindingName}" has type "${type}"`
      )
    }
    return { credentialName: bindingName, type, venue: type, data }
  }

  /** Materialize the strategy's account slots into Readers (+ per-slot account facts). */
  private async materializeStrategySlots(
    instance: StrategyInstance,
    strategy: IStrategy,
  ): Promise<{ readers: unknown[]; credentialNames: string[]; accountMetas: import('../types/strategy.js').AccountSlotMeta[] }> {
    const readers: unknown[] = []
    const credentialNames: string[] = []
    const accountMetas: import('../types/strategy.js').AccountSlotMeta[] = []

    for (let i = 0; i < strategy.accounts.length; i++) {
      const slot = strategy.accounts[i]!
      const name = this.boundCredential(instance, slot.label, instance.accounts?.[i])
      if (!name) {
        throw new Error(
          `Strategy "${instance.strategyId}" account slot '${slot.label}' has no credential bound ` +
          `in instance "${instance.id}" (set credentials['${slot.label}'])`
        )
      }
      const kind = slot.account.kind
      if (!kind) {
        // registerStrategy validates this; kept for strategies reaching
        // activation through a path that skipped registration
        throw new Error(`Account slot '${slot.label}': Reader class has no kind`)
      }
      const resolved = await this.resolveAccountBinding(name, {
        kind,
        ...(slot.account.venueType !== undefined ? { venueType: slot.account.venueType } : {}),
        context: `Account slot '${slot.label}' of instance "${instance.id}"`,
      })

      const session = await this.ensureSession(instance.id, resolved.credentialName, resolved.type, kind, resolved.data, resolved.venue)
      // Account entity → its implementation builds the read view; legacy bare-
      // credential binding → venue reader override, then the kind-GENERIC
      // account implementation (the canonical read view of the kind).
      let reader: unknown
      if (resolved.impl) {
        reader = resolved.impl.createReader(session, name, resolved.params)
      } else {
        const readerOverrides = this.credentialTypes.get(resolved.type)?.readers as
          Record<string, (session: unknown, credentialName: string) => unknown> | undefined
        const readerFactory = readerOverrides?.[kind]
          ?? this.readerFactoryForKind(kind, resolved.type)
        if (!readerFactory) {
          throw new Error(`Kind "${kind}" has no account implementation — is its domain plugin loaded?`)
        }
        reader = readerFactory(session, name)
      }
      readers.push(reader)
      credentialNames.push(resolved.credentialName)
      // The venue is derived from the binding (impl pin, else the credential's
      // type) — strategies never ask the user for a venue the binding implies
      accountMetas.push({ label: slot.label, accountName: name, venue: resolved.venue, kind })
    }

    return { readers, credentialNames, accountMetas }
  }

  /** Materialize each declared executor's credential slots (sessions / raw data). */
  private async materializeExecutorSlots(
    instance: StrategyInstance,
    strategy: IStrategy,
    executorLabelToKey: Map<string, string>,
  ): Promise<void> {
    for (const [execLabel, resolvedId] of executorLabelToKey) {
      const executor = this.executorRegistry.get(resolvedId)
      // A silently-missing executor means instructions queue up with no consumer —
      // fail at activation, symmetrically with missing monitors.
      if (!executor) {
        throw new Error(
          `Instance "${instance.id}": strategy "${instance.strategyId}" declares executor "${resolvedId}" but it is not registered`
        )
      }
      if (executor.credentials.length === 0) continue

      const slots: MaterializedSlot[] = []
      for (const decl of executor.credentials) {
        const slotPath = `${execLabel}:${decl.label}`
        // Executor slots default to the strategy binding that satisfies them —
        // single-credential instances need no extra configuration.
        const name = this.boundCredential(instance, slotPath)
          ?? await this.defaultExecutorBinding(instance, strategy, decl)
        if (!name) {
          // Optional slots stay unmaterialized — the executor degrades gracefully
          if (decl.optional) continue
          throw new Error(
            `Executor slot '${slotPath}' of instance "${instance.id}" has no credential bound ` +
            `and no strategy binding satisfies it (set credentials['${slotPath}'])`
          )
        }
        if ('raw' in decl) {
          // Raw slots bind CREDENTIALS (never accounts) — raw is the key itself.
          const { type, data } = await this.readCredential(name)
          if (decl.type !== type) {
            throw new Error(`Executor slot '${slotPath}' requires a "${decl.type}" credential, but "${name}" is "${type}"`)
          }
          if (!this.credentialTypes.get(type)?.raw) {
            throw new Error(`Credential type "${type}" does not allow raw materialization (slot '${slotPath}')`)
          }
          slots.push({ label: decl.label, credentialName: name, raw: data })
        } else {
          // Account slots: the binding is an account name (full body = the
          // session behind the account), legacy credential names accepted.
          const resolved = await this.resolveAccountBinding(name, {
            kind: decl.kind,
            ...(decl.type !== undefined ? { venueType: decl.type } : {}),
            context: `Executor slot '${slotPath}' of instance "${instance.id}"`,
          })
          const session = await this.ensureSession(instance.id, resolved.credentialName, resolved.type, decl.kind, resolved.data, resolved.venue)
          slots.push({ label: decl.label, credentialName: resolved.credentialName, session })
        }
      }

      // Sessions for every strategy-bound credential of matching kinds are also
      // exposed by name, so instruction.accountNames can route among them.
      const sessionKinds = new Set(
        executor.credentials.flatMap(d => 'raw' in d ? [] : [d.kind])
      )
      const extraByName: MaterializedSlot[] = []
      for (const bindingName of this.instanceSessionsByName(instance)) {
        // Bindings may be account names — the session cache is keyed by the
        // underlying credential (venue-suffixed for pinned impls), but
        // instruction routing speaks binding names.
        const entity = await this.accountStore.get(bindingName)
        const credentialName = entity?.credential ?? bindingName
        const entityImpl = entity ? this.accountImpls.get(entity.implementation)?.impl : undefined
        const pinnedVenue = entityImpl ? implementationVenue(entityImpl) : undefined
        for (const kind of sessionKinds) {
          const cached = this.sessions.get(sessionKey(credentialName, kind, pinnedVenue))
            ?? (pinnedVenue !== undefined ? this.sessions.get(sessionKey(credentialName, kind)) : undefined)
          if (cached && !slots.some(s => s.credentialName === credentialName && s.session === cached.session)) {
            extraByName.push({ label: `@${bindingName}`, credentialName, session: cached.session })
          }
        }
      }

      executor.setMaterialized(instance.id, [...slots, ...extraByName])
    }
  }

  /** First strategy-bound credential whose type can materialize the executor slot. */
  private async defaultExecutorBinding(
    instance: StrategyInstance,
    strategy: IStrategy,
    decl: { kind?: NamespacedKind; type?: string },
  ): Promise<string | undefined> {
    const names = strategy.accounts
      .map((slot, i) => this.boundCredential(instance, slot.label, instance.accounts?.[i]))
      .filter((n): n is string => n !== undefined)
    for (const name of names) {
      // Bindings may be account names; fall through to the credential itself
      const entity = await this.accountStore.get(name)
      let pinnedVenue: string | undefined
      if (entity && decl.kind !== undefined) {
        const impl = this.accountImpls.get(entity.implementation)?.impl
        if (impl?.kind !== decl.kind || !entity.credential) continue
        pinnedVenue = implementationVenue(impl)
      }
      const credentialName = entity?.credential ?? name
      let type: string
      try {
        ({ type } = await this.readCredential(credentialName))
      } catch {
        continue
      }
      // A venue-pinned account satisfies the slot through its cell, whatever
      // key family opens it — the credential type is not the venue on-chain.
      if (pinnedVenue !== undefined && decl.kind !== undefined) {
        const accepted = this.adapterRegistry.acceptedCredentialTypes(decl.kind, pinnedVenue)
        if (accepted?.includes(type) && (decl.type === undefined || decl.type === pinnedVenue)) return name
      }
      if (decl.type !== undefined) {
        const accepted = decl.kind !== undefined
          ? this.adapterRegistry.acceptedCredentialTypes(decl.kind, decl.type)
          : undefined
        if (accepted) {
          if (!accepted.includes(type)) continue
          return name
        }
        if (decl.type !== type) continue
      }
      const factories = this.credentialTypes.get(type)?.factories as Record<string, unknown> | undefined
      if (decl.kind !== undefined && !this.adapterRegistry.has(decl.kind, type) && !factories?.[decl.kind]) continue
      return name
    }
    return undefined
  }

  private async readCredential(name: string): Promise<{ type: string; data: RawCredentialData }> {
    if (!this.credentialStore) {
      throw new Error(`CredentialStore not configured — cannot materialize credential "${name}"`)
    }
    return this.credentialStore.getByName(name)
  }

  /** Get or create the session for credential × kind; tracked per instance for lifecycle. */
  private async ensureSession(
    instanceId: string,
    name: string,
    type: string,
    kind: NamespacedKind,
    data: RawCredentialData,
    venue?: string,
  ): Promise<unknown> {
    const cellVenue = venue ?? type
    const key = sessionKey(name, kind, cellVenue !== type ? cellVenue : undefined)
    let entry = this.sessions.get(key)
    if (!entry) {
      // Adapter cell first (the venue × kind matrix), legacy per-credential-type
      // factories as fallback until every venue plugin migrates to `adapters`.
      const legacyFactories = this.credentialTypes.get(type)?.factories as
        Record<string, (data: RawCredentialData) => unknown> | undefined
      const factory = this.adapterRegistry.factoryFor(kind, cellVenue) ?? legacyFactories?.[kind]
      if (!factory) {
        const available = [
          ...this.adapterRegistry.kindsForType(type),
          ...Object.keys(legacyFactories ?? {}),
        ]
        throw new Error(
          `Credential type "${type}" has no adapter for kind "${kind}" venue "${cellVenue}" ` +
          `(credential: "${name}") — available kinds: ${available.join(', ') || 'none'}`,
        )
      }
      entry = { session: factory(data), instances: new Set() }
      this.sessions.set(key, entry)
    }
    entry.instances.add(instanceId)
    return entry.session
  }

  /** Credential names bound to any of the instance's strategy slots. */
  private instanceSessionsByName(instance: StrategyInstance): string[] {
    const fromMap = Object.values(instance.credentials ?? {})
    const fromArray = instance.accounts ?? []
    return Array.from(new Set([...fromMap, ...fromArray]))
  }
}
