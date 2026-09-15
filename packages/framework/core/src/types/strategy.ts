import type { ExecutionInstruction, ExecutionResult } from './executor.js'
import type { MonitorDataReader } from './monitor.js'
import type { CredentialStore } from './credential.js'
import type { RetryOptions } from './executor.js'
import type { IStrategyStore } from '../strategy/StrategyStore.js'
import type { HttpClient } from '../strategy/HttpClient.js'
import type { Trigger, MonitorSource } from './trigger.js'
import type { StrategyParams } from './instance.js'
import type { AccountSlot } from './materialization.js'
import type { ZodObject, ZodRawShape } from 'zod'
import type { AvailabilityChecker, ParamFieldDef, ParamIllustration, ParamPreset, PickerOption, PresetContext, PresetSource } from './definition.js'
import type { IPortfolioJournal, PortfolioMode } from './portfolio.js'
import type { PortfolioUpdate } from './portfolio.js'

/**
 * Monitor dependency declaration.
 * - string shorthand: `'user-trades'` → name = label = 'user-trades', resolved with current namespace
 * - object form: `{ name: 'user-trades', label: 'trades' }` → custom label for in-strategy access
 * - cross-plugin: `{ name: 'chainlink/price', label: 'price' }` → name contains '/', used as-is
 */
/** One leg of an instance's position — see IStrategy.positionLegs(). */
export interface PositionLeg {
  /** The credential the leg trades on: a value of the instance's bindings. */
  credential: string
  /** The contract, as the venue names it ('CL/USDT:USDT'). */
  symbol: string
  /** Omitted = whichever side is held. */
  side?: 'long' | 'short'
}

export type MonitorDeclaration = string | { name: string; label: string }

/**
 * Executor dependency declaration.
 * Same rules as MonitorDeclaration.
 */
export type ExecutorDeclaration = string | { name: string; label: string }

export interface StrategyContext {
  instanceId: string
  triggerId: string
  /**
   * Flattened monitor data at the time of trigger, keyed by '{label}:{key}'.
   * Use getData(label, key) for convenient access.
   */
  monitorData: Record<string, Record<string, unknown>>
  timestamp: number
  /**
   * True when the instance runs with the framework's Dry run option: what
   * this run returns is recorded and not sent, and no result comes back.
   * A strategy declares no dry-run switch of its own; it reads this only
   * where its own memory depends on whether an order actually went out.
   */
  dryRun?: boolean
  /**
   * Retrieve trigger data for a specific monitor label and key.
   * Returns undefined if this monitor/key did not contribute to the trigger.
   */
  getData(monitorLabel: string, key: string): Record<string, unknown> | undefined
}

export interface StrategyMetrics {
  runsTotal: number
  instructionsEmitted: number
  lastRunAt?: number
  errors: number
}

/** Built-in provider IDs with predefined default credential names. */
export type BuiltinProviderId = 'openai' | 'anthropic' | 'google' | 'mistral' | 'cohere' | 'groq' | 'xai'

export interface BuiltinProviderConfig {
  provider: BuiltinProviderId
  /** Override the default credential name. Defaults to `${provider}-api-key`. */
  credentialName?: string
}

export interface CustomProviderConfig {
  provider: 'custom'
  /** Provider ID used as the prefix in model strings, e.g. `'my-provider:model-name'`. */
  id: string
  /** A factory that receives the raw API key string and returns a Vercel AI SDK LanguageModelV1. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create: (apiKey: string) => (modelId: string) => any
  credentialName: string
}

export type ProviderConfig = BuiltinProviderConfig | CustomProviderConfig

export interface LlmOptions {
  /**
   * Default model in `'provider:model'` format, e.g. `'openai:gpt-4o'`.
   * Can be overridden per-call in `llm({ model: '...' })`.
   */
  defaultModel?: string
  /**
   * Override credential names for built-in providers, or register custom providers.
   * Built-in providers without an entry here use `${provider}-api-key` as the credential name.
   */
  providers?: ProviderConfig[]
}

export interface StrategyOptions {
  dataDir?: string
  llm?: LlmOptions
}

/**
 * The strategy speaks in LABELS only — its declarations' local names.
 * Registry keys (namespace-prefixed ids) are the framework's currency; the
 * runtime resolves labels to registry keys at activation using the strategy
 * definition's pluginName. A strategy never learns which namespace it was
 * registered under.
 *
 * Strategies are strictly read-only: account slots declare Reader classes
 * and the framework injects Reader instances — a session (write-capable
 * connection) is structurally unreachable from strategy code. Order flow
 * must travel instruction → queue → executor.
 */
/**
 * A named LLM slot declared by a strategy: label + default model, optionally a
 * pinned credential and AI SDK settings. Instances may override per label.
 */
export interface LlmDeclaration {
  label: string
  /** Default model, `'provider:model'`. */
  model: string
  credentialName?: string
  /** AI SDK settings passthrough (temperature, maxOutputTokens, …). */
  settings?: Record<string, unknown>
}

/** Instance-level override for one LLM slot (all fields optional). */
export interface LlmSlotBinding {
  model?: string
  credentialName?: string
  settings?: Record<string, unknown>
}

/**
 * Facts about one bound account slot, injected at activation. The venue is
 * DERIVED from the bound Account (its credential's type) — strategies must
 * never ask the user for a venue a binding already implies.
 */
export interface AccountSlotMeta {
  label: string
  /** The binding value: the Account entity's name (or, legacy, the credential name). */
  accountName: string
  /** The account's venue = its credential's type ('binance', 'hyperliquid', …). */
  venue: string
  kind: string
}

/** Why a lifecycle hook is running — the same word the runtime uses for the transition. */
export type LifecycleReason = 'activate' | 'boot' | 'restart' | 'rollback' | 'stop' | 'delete' | 'shutdown'

export interface LifecycleContext {
  instanceId: string
  reason: LifecycleReason
  /** The instance's Dry run option — see StrategyContext.dryRun. */
  dryRun?: boolean
}

/** Trace of one finished run — what the strategy saw, decided, and emitted. */
export interface StrategyRunTrace {
  /**
   * Identity of this run, unique per instance and stable on disk. The SAME
   * string scopes the run's log lines and stamps the instructions it emitted,
   * so an execution leads back to exactly one trace. Absent on traces written
   * before it existed.
   */
  runId?: string
  startedAt: number
  triggerId: string
  durationMs: number
  instructions: number
  error?: string
  steps: Array<{ ts: number; step: string; data?: Record<string, unknown> }>
}

/**
 * A strategy-owned portfolio projection for instance dashboards.
 *
 * The framework only standardizes the execution mode and observation time;
 * positions, fills, and risk metrics remain strategy-domain data.
 */
export interface StrategyPortfolioSnapshot {
  /** Simulations only. Live PnL lives in the pnl_* ledger — see types/portfolio.ts. */
  mode: PortfolioMode
  updatedAt: number
}

/** Runtime-injected hooks for mid-run monitor sources (see IStrategy.setDynamicSources). */
export interface DynamicSourceHooks {
  addSubscription(source: MonitorSource): void
  addTrigger(trigger: Omit<Trigger, 'id' | 'strategyInstanceId'>): void
}

export interface IStrategy {
  readonly strategyId: string
  /** Monitor declarations this strategy depends on. */
  readonly monitors: readonly MonitorDeclaration[]
  /** Executor declarations this strategy depends on. */
  readonly executors: readonly ExecutorDeclaration[]
  /** Account slots: Reader class references. Framework materializes credentials into Readers at activate(). */
  readonly accounts: readonly AccountSlot[]
  /** Named LLM slots. Instance bindings may override model/credential/settings per label. */
  readonly llms: readonly LlmDeclaration[]
  /** Base params schema (required fields, no defaults). */
  readonly baseParamsSchema: ZodObject<ZodRawShape>
  /** Tunable params schema (AI-optimizable, all fields must have .default()). */
  readonly tunableParamsSchema: ZodObject<ZodRawShape>
  /** Field descriptors for generic UI rendering. Optional. */
  readonly paramsFields?: ParamFieldDef[]
  /** Interactive/illustrative HTML docs for the param form — see ParamIllustration. */
  readonly paramsIllustrations?: ParamIllustration[]
  /** Named parameter starting points the form offers — see ParamPreset. */
  readonly paramPresets?: ParamPreset[]
  /** Heading, blurb and cache life of the live presets, when `presets()` is implemented. */
  readonly presetSource?: PresetSource
  /**
   * Compute presets live — the opportunities a scan would rank, each one a
   * card with the params that take it. Called on a probe instance (no store,
   * no accounts materialized) with keyless adapters; the result is cached
   * by the runtime for `presetSource.ttlMs`. Static `paramPresets`, if any,
   * are listed first.
   */
  presets?(ctx: PresetContext): Promise<ParamPreset[]>
  /**
   * Live figures for the param illustrations: called with the form's current
   * values (and keyless adapters) whenever they change, debounced; whatever
   * it returns is posted to every illustration frame as `data`. A probe
   * instance, like presets(). Throw to have the frame told `dataError`.
   */
  illustrationData?(ctx: PresetContext): Promise<Record<string, unknown>>
  /**
   * Options for a field declared with `meta({ picker: { source: 'strategy', id } })`:
   * the decisions an operator may choose between, each with the value that
   * takes it and a card to compare by. Probe rules as presets(); cached by
   * the runtime for the picker's ttl.
   */
  pickerOptions?(pickerId: string, ctx: PresetContext): Promise<PickerOption[]>
  /**
   * The positions an instance of this strategy holds, as legs: which bound
   * credential, which contract, and optionally which side (omitted = either
   * side, for strategies that trade both directions). The dashboard groups
   * them into one combination per instance so a multi-leg trade reads as one
   * line with one PnL. Called on a probe with the instance's bindings and
   * params; synchronous and cheap — no venue calls. Absent = no automatic
   * combination.
   */
  positionLegs?(ctx: { accounts: Record<string, string>; params: StrategyParams }): PositionLeg[]
  /**
   * Availability checkers this strategy provides, keyed by the name a field's
   * `meta({ availability: { checker } })` refers to. Pure functions over the
   * venue's market list — see AvailabilityChecker.
   */
  readonly availabilityCheckers?: Readonly<Record<string, AvailabilityChecker>>
  /** Returns the triggers this strategy needs, given its params. Framework fills id/strategyInstanceId. */
  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[]
  /**
   * Monitors to keep RUNNING whose emits must not wake this strategy.
   *
   * Subscription and triggering are separate concerns that a MonitorCondition
   * conflates: naming a monitor in a trigger is the only way to keep it
   * collecting, so a strategy that merely needs a monitor's history on disk
   * has to accept being run on every emit. That is not free — two triggers can
   * reach run() concurrently, and a strategy whose real schedule is a cron
   * then races itself through whatever de-duplication it keeps in its store.
   *
   * Declare those monitors here instead: they are subscribed and unsubscribed
   * exactly like a trigger's sources, but no trigger condition references
   * them, so their emits satisfy nothing and fire nothing. Read them with
   * monitorData(label) when the strategy does run.
   */
  subscriptions?(params: StrategyParams): MonitorSource[]
  /** Current portfolio projection, when the strategy maintains one. */
  getPortfolioSnapshot?(): Promise<StrategyPortfolioSnapshot | undefined>
  /** Complete current projection for idempotent journal recovery. */
  getPortfolioUpdate?(): Promise<PortfolioUpdate | undefined>
  run(context: StrategyContext): Promise<ExecutionInstruction[]>
  /**
   * Called with an executor's result for an instruction THIS instance emitted,
   * after the result has been recorded. Fire-and-forget from the runtime's
   * side: a throwing hook is logged and never affects the execution record or
   * the queue. `this.store` works here; `this.trace` is a no-op unless a run
   * happens to be active.
   */
  onExecutionResult?(result: ExecutionResult, ctx: { instanceId: string }): Promise<void> | void
  /**
   * The strategy's own moment at the start: every setter has run, triggers
   * are registered, nothing has fired yet. Baselines, leverage, a leftover
   * quote from the last activation — housekeeping that would otherwise spend
   * the first trigger. Returned instructions are fired inline and awaited
   * before the first trigger may fire. A throw fails the activation.
   */
  onActivate?(ctx: LifecycleContext): Promise<ExecutionInstruction[] | void> | ExecutionInstruction[] | void
  /**
   * The strategy's own moment at the end: no run is in flight and no new one
   * can start, executor slots are still materialized. Returned instructions
   * are fired inline and awaited — a resting quote cancelled here is cancelled
   * by the slots that are about to be removed. A throw or a failed instruction
   * is logged; teardown continues, because an instance that cannot be
   * deactivated would resume trading on the next boot.
   */
  onDeactivate?(ctx: LifecycleContext): Promise<ExecutionInstruction[] | void> | ExecutionInstruction[] | void
  /**
   * Run a lifecycle hook under the strategy's trace machinery, so the
   * instance board shows what activation and deactivation did. Provided by
   * BaseStrategy; the runtime calls the hook directly when absent.
   */
  lifecycle?(reason: LifecycleReason, work: () => Promise<ExecutionInstruction[] | void> | ExecutionInstruction[] | void): Promise<ExecutionInstruction[]>
  getMetrics(): StrategyMetrics
  setMonitorReader(label: string, reader: MonitorDataReader): void
  setCredentialStore(store: CredentialStore): void
  setStore(store: IStrategyStore): void
  /** Runtime-injected instance-scoped portfolio journal. */
  setPortfolioJournal?(journal: IPortfolioJournal): void
  setHttpClient(client: HttpClient): void
  setParams(params: StrategyParams): void
  setLlmBindings(bindings: Record<string, LlmSlotBinding>): void
  /**
   * Inject materialized Readers, parallel to the accounts declaration order,
   * with the bound credential names (used by instruction() for accountNames).
   */
  setReaders(readers: unknown[], credentialNames: string[]): void
  /**
   * Inject per-slot account facts (bound name, venue, kind) — set BEFORE
   * triggers(), so venue-scoped subscriptions derive from the bound Account
   * instead of duplicating a venue parameter.
   */
  setAccountMeta(metas: AccountSlotMeta[]): void
  setInstanceId(instanceId: string): void
  /**
   * Persistence hook for finished run traces, injected at activation. Optional
   * so strategy bundles compiled against an older base keep loading.
   */
  setRunSink?(sink: ((run: StrategyRunTrace) => void) | null): void
  /**
   * Runtime hooks for sources discovered AFTER activation: start collecting a
   * monitor key mid-run and optionally wake on its pushes. Injected by the
   * TriggerManager at registration; absent on older runtimes.
   */
  setDynamicSources?(hooks: DynamicSourceHooks): void
  /** Validate a monitor declaration (label or index) and return its label. Used in triggers(). */
  monitor(labelOrIndex: string | number): string
  /** Validate an executor declaration (label or index) and return its label. Used in evaluate(). */
  executor(labelOrIndex: string | number): string
}
