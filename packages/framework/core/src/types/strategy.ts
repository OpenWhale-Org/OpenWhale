import type { ExecutionInstruction } from './executor.js'
import type { MonitorDataReader } from './monitor.js'
import type { CredentialStore } from './credential.js'
import type { RetryOptions } from './executor.js'
import type { IStrategyStore } from '../strategy/StrategyStore.js'
import type { HttpClient } from '../strategy/HttpClient.js'
import type { Trigger, MonitorSource } from './trigger.js'
import type { StrategyParams } from './instance.js'
import type { AccountSlot } from './materialization.js'
import type { ZodObject, ZodRawShape } from 'zod'
import type { AvailabilityChecker, ParamFieldDef, ParamIllustration, ParamPreset } from './definition.js'
import type { IPortfolioJournal, PortfolioMode } from './portfolio.js'
import type { PortfolioUpdate } from './portfolio.js'

/**
 * Monitor dependency declaration.
 * - string shorthand: `'user-trades'` → name = label = 'user-trades', resolved with current namespace
 * - object form: `{ name: 'user-trades', label: 'trades' }` → custom label for in-strategy access
 * - cross-plugin: `{ name: 'chainlink/price', label: 'price' }` → name contains '/', used as-is
 */
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

/** Trace of one finished run — what the strategy saw, decided, and emitted. */
export interface StrategyRunTrace {
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
