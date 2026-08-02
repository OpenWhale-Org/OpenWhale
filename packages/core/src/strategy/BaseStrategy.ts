import type { ExecutionInstruction } from '../types/executor.js'
import type { IStrategy, StrategyContext, StrategyMetrics, StrategyOptions, MonitorDeclaration, ExecutorDeclaration, LlmDeclaration, LlmSlotBinding, AccountSlotMeta, StrategyRunTrace } from '../types/strategy.js'
import type { MonitorDataReader } from '../types/monitor.js'
import type { CredentialStore, CredentialData } from '../types/credential.js'
import type { IStrategyStore } from './StrategyStore.js'
import type { ZodType, ZodRawShape } from 'zod'
import type { Trigger, MonitorSource } from '../types/trigger.js'
import type { StrategyParams } from '../types/instance.js'
import type { AccountSlot, ReaderClass } from '../types/materialization.js'
import type { AvailabilityChecker, ListColumnDef, ListParamDef, ParamFieldDef, ParamFieldMeta, ParamFieldType } from '../types/definition.js'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { getDataDir } from '../utils/paths.js'
import { createLogger , subscribeLogs } from '../utils/logger.js'
import { LlmClient } from './llm.js'
import type { CoreMessage, LlmCallOptions, LlmCallSettings } from './llm.js'
import type { LanguageModel } from 'ai'
import { HttpClient } from './HttpClient.js'
import { decoratedDeclarations } from './decorators.js'

export type { CoreMessage }

/**
 * A strategy's dependency declarations, grouped for typed label inference.
 *
 * Declare once `as const satisfies StrategyDeclarations`, pass its typeof as
 * BaseStrategy's type argument, and monitor()/executor()/account()/instruction()
 * autocomplete their labels and reject typos at compile time:
 *
 *   const decls = {
 *     monitors: [{ name: 'user-trades', label: 'trades' }],
 *     executors: [{ name: 'perp-trading', label: 'perp' }],
 *     accounts: [{ account: PerpAccount, label: 'main' }],
 *   } as const satisfies StrategyDeclarations
 *
 *   class MyStrategy extends BaseStrategy<typeof decls> {
 *     override readonly monitors = decls.monitors
 *     override readonly executors = decls.executors
 *     override readonly accounts = decls.accounts
 *     ...
 *   }
 *
 * The type argument is optional — `extends BaseStrategy` alone keeps every
 * label parameter as plain string.
 *
 * Alternatively, declare with the @monitor/@executor/@account class decorators
 * (see decorators.ts) — same runtime behaviour, no label typing.
 */
export interface StrategyDeclarations {
  monitors?: readonly MonitorDeclaration[]
  executors?: readonly ExecutorDeclaration[]
  accounts?: readonly AccountSlot[]
  llms?: readonly LlmDeclaration[]
}

/** Union of the labels in a declarations tuple type; plain string for wide types. */
export type DeclarationLabel<T> = [T] extends [readonly (infer D)[]]
  ? D extends string ? D
  : D extends { readonly label: infer L extends string } ? L
  : never
  : string

type MonitorLabel<TDecl extends StrategyDeclarations> = DeclarationLabel<Exclude<TDecl['monitors'], undefined>>
type ExecutorLabel<TDecl extends StrategyDeclarations> = DeclarationLabel<Exclude<TDecl['executors'], undefined>>
type AccountLabel<TDecl extends StrategyDeclarations> = DeclarationLabel<Exclude<TDecl['accounts'], undefined>>
type LlmLabel<TDecl extends StrategyDeclarations> = DeclarationLabel<Exclude<TDecl['llms'], undefined>>

/**
 * The Reader type of an account slot, looked up by its label — the
 * InstanceType of the Reader class the declaration references. Declaring a
 * venue subclass (e.g. HyperliquidAccount) surfaces its extra typed methods.
 */
type ReaderOfLabel<TDecl extends StrategyDeclarations, L> =
  [Extract<NonNullable<TDecl['accounts']>[number], { readonly label: L }>] extends
    [{ readonly account: infer C extends ReaderClass }]
    ? C['prototype']
    : unknown

/**
 * @ai-guide How to write a Strategy
 *
 * A Strategy receives a trigger context, makes decisions, and returns a batch of ExecutionInstructions.
 * Subclasses only need to implement `evaluate(context)`; the base class provides decision helpers,
 * data access, and LLM inference capabilities.
 *
 * Basic example:
 * ```typescript
 * class MyStrategy extends BaseStrategy {
 *   readonly strategyId = 'my-strategy'
 *
 *   async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
 *     const price = await this.step('price', () => fetchPrice())
 *     return this.when(price > 100, [
 *       { executorId: 'trade', messageId: '', action: 'buy', params: { symbol: 'BTC' } }
 *     ])
 *   }
 * }
 * ```
 *
 * Using LLM inference (structured output):
 * ```typescript
 * class AiStrategy extends BaseStrategy {
 *   readonly strategyId = 'ai-strategy'
 *
 *   constructor() {
 *     super({ llm: { defaultModel: 'openai:gpt-4o' } })
 *     // requires 'openai-api-key' stored in CredentialStore
 *   }
 *
 *   async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
 *     const data = await this.monitorData('market')?.getLatest()
 *
 *     const decision = await this.llm({
 *       messages: [
 *         { role: 'system', content: 'You are a trading analyst. Recommend an action based on market data.' },
 *         { role: 'user', content: JSON.stringify(data) },
 *       ],
 *       schema: z.object({
 *         action: z.enum(['buy', 'sell', 'hold']),
 *         reason: z.string(),
 *       }),
 *     })
 *     // decision: { action: 'buy' | 'sell' | 'hold', reason: string }
 *
 *     return this.when(decision.action !== 'hold', [
 *       { executorId: 'trade', messageId: '', action: decision.action, params: {} }
 *     ])
 *   }
 * }
 * ```
 *
 * Using a custom provider:
 * ```typescript
 * class CustomAiStrategy extends BaseStrategy {
 *   constructor() {
 *     super({
 *       llm: {
 *         defaultModel: 'my-llm:my-model',
 *         providers: [{
 *           provider: 'custom',
 *           id: 'my-llm',
 *           credentialName: 'my-llm-api-key',
 *           create: (apiKey) => (modelId) => createMyProvider({ apiKey })(modelId),
 *         }],
 *       },
 *     })
 *   }
 * }
 * ```
 */
export abstract class BaseStrategy<TDecl extends StrategyDeclarations = StrategyDeclarations> implements IStrategy {
  /**
   * Unique strategy id. Set via `readonly strategyId = '...'` or `@strategy('...')`.
   * Not abstract so the decorator form can satisfy it — a strategy that sets
   * it neither way is rejected at registration.
   */
  readonly strategyId: string = ''
  /** Declare monitor dependencies. Use `{ name, label }` for named access, or plain string for name=label. */
  readonly monitors: readonly MonitorDeclaration[] = []
  /** Declare executor dependencies. Use `{ name, label }` for named access, or plain string for name=label. */
  readonly executors: readonly ExecutorDeclaration[] = []
  /** Account slots: Reader class references — the ONLY venue view a strategy can hold. */
  readonly accounts: readonly AccountSlot[] = []
  /** Named LLM slots: label + default model/credential/settings. Instances override per label. */
  readonly llms: readonly LlmDeclaration[] = []

  /** Base params schema (required, no defaults). Override in subclass. */
  readonly baseParamsSchema: z.ZodObject<z.ZodRawShape> = z.object({})
  /** Tunable params schema (AI-optimizable, all fields must have .default()). Override in subclass. */
  readonly tunableParamsSchema: z.ZodObject<z.ZodRawShape> = z.object({})

  /**
   * Availability checkers for params whose `meta({ availability: { checker } })`
   * names one. Pure functions over the venue's market list — the runtime
   * fetches those and calls in.
   */
  readonly availabilityCheckers: Readonly<Record<string, AvailabilityChecker>> = {}

  /**
   * Derived from baseParamsSchema + tunableParamsSchema via .meta() annotations.
   * Override manually only if you need full control over the UI descriptor.
   */
  get paramsFields(): ParamFieldDef[] {
    return BaseStrategy.deriveParamFields(this.baseParamsSchema, this.tunableParamsSchema) ?? []
  }

  /**
   * Derive ParamFieldDef[] from two ZodObject schemas.
   * Reads .meta() on each field for UI metadata; infers type from Zod type string.
   * Returns undefined if both schemas have empty shapes (no fields to show).
   */
  static deriveParamFields(
    baseSchema: z.ZodObject<ZodRawShape>,
    tunableSchema: z.ZodObject<ZodRawShape>,
  ): ParamFieldDef[] | undefined {
    const baseKeys = Object.keys(baseSchema.shape)
    const tunableKeys = Object.keys(tunableSchema.shape)
    if (baseKeys.length === 0 && tunableKeys.length === 0) return undefined

    const fields: ParamFieldDef[] = []

    /** Peel .default()/.optional() wrappers: inner type + default + the first non-empty meta. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function unwrap(rawField: unknown): { field: any; meta: ParamFieldMeta; defaultValue: unknown; wrapped: boolean } {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let field: any = rawField
      let defaultValue: unknown = undefined
      let wrapped = false

      // Read meta from the outermost wrapper first (covers .default().meta() pattern)
      let meta: ParamFieldMeta = field.meta?.() ?? {}

      if (field.type === 'default') {
        defaultValue = typeof field.def.defaultValue === 'function'
          ? field.def.defaultValue()
          : field.def.defaultValue
        field = field.def.innerType
        wrapped = true
        // If meta was empty on the wrapper, try the inner type (.meta().default() pattern)
        if (Object.keys(meta).length === 0) meta = field.meta?.() ?? {}
      }

      if (field.type === 'optional') {
        field = field.def.innerType
        wrapped = true
        if (Object.keys(meta).length === 0) meta = field.meta?.() ?? {}
      }

      return { field, meta, defaultValue, wrapped }
    }

    /**
     * An array-of-objects param renders as an editable row list: the element
     * shape becomes the columns, each column's .meta() its display info.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function deriveListDef(arrayField: any, meta: ParamFieldMeta): ListParamDef | undefined {
      const element = arrayField.def?.element
      const shape: ZodRawShape | undefined = element?.type === 'object'
        ? (element.def?.shape ?? element.shape)
        : undefined
      if (!shape) return undefined

      const columns: ListColumnDef[] = Object.entries(shape).map(([name, raw]) => {
        const col = unwrap(raw)
        const zt: string = col.field.type ?? ''
        const type = col.meta.options?.length ? 'options' as const
          : zt === 'number' ? 'number' as const
          : zt === 'boolean' ? 'boolean' as const
          : 'string' as const
        return {
          name,
          displayName: col.meta.displayName ?? name,
          type,
          ...(col.meta.options ? { options: col.meta.options } : {}),
          ...(col.meta.slider ? { slider: col.meta.slider } : {}),
          ...(col.meta.catalogue ? { catalogue: col.meta.catalogue } : {}),
          ...(col.meta.unit ? { unit: col.meta.unit } : {}),
          ...(col.meta.placeholder ? { placeholder: col.meta.placeholder } : {}),
          ...(col.meta.description ? { description: col.meta.description } : {}),
          ...(col.defaultValue !== undefined ? { default: col.defaultValue } : {}),
        }
      })
      return { columns, ...(meta.list ?? {}) }
    }

    function processShape(shape: ZodRawShape, group: 'base' | 'tunable') {
      for (const [name, rawField] of Object.entries(shape)) {
        const { field, meta, defaultValue, wrapped } = unwrap(rawField)
        const required = group === 'base' && !wrapped

        const zodType: string = field.type ?? ''
        const fieldType = BaseStrategy.zodTypeToParamFieldType(zodType, meta)
        const list = fieldType === 'list' ? deriveListDef(field, meta) : undefined

        fields.push({
          name,
          displayName: meta.displayName ?? name,
          type: fieldType,
          group,
          ...(defaultValue !== undefined ? { default: defaultValue } : {}),
          ...(required ? { required: true } : {}),
          ...(meta.description ? { description: meta.description } : {}),
          ...(meta.hint ? { hint: meta.hint } : {}),
          ...(meta.section ? { section: meta.section } : {}),
          ...(meta.placeholder ? { placeholder: meta.placeholder } : {}),
          ...(meta.options ? { options: meta.options } : {}),
          ...(meta.displayOptions ? { displayOptions: meta.displayOptions } : {}),
          ...(meta.catalogue ? { catalogue: meta.catalogue } : {}),
          ...(meta.availability ? { availability: meta.availability } : {}),
          ...(meta.multiple ? { multiple: true } : {}),
          ...(meta.slider ? { slider: meta.slider } : {}),
          ...(meta.unit ? { unit: meta.unit } : {}),
          ...(list ? { list } : {}),
        })
      }
    }

    processShape(baseSchema.shape, 'base')
    processShape(tunableSchema.shape, 'tunable')

    return fields
  }

  private static zodTypeToParamFieldType(zodType: string, meta: ParamFieldMeta): ParamFieldType {
    if (meta.options && meta.options.length > 0) return 'options'
    switch (zodType) {
      case 'number': return 'number'
      case 'boolean': return 'boolean'
      case 'array': return 'list'
      default: return 'string'
    }
  }

  protected readonly dataDir: string
  private readonly stepCache = new Map<string, unknown>()
  private readonly metrics: StrategyMetrics = {
    runsTotal: 0,
    instructionsEmitted: 0,
    errors: 0,
  }

  private monitorReaders = new Map<string, MonitorDataReader>()
  private credentialStore?: CredentialStore
  private storeInstance?: IStrategyStore
  private httpClient?: HttpClient
  private readonly llmClient: LlmClient
  private llmBindings: Record<string, LlmSlotBinding> = {}
  private injectedParams?: StrategyParams
  private injectedReaders: unknown[] = []
  private injectedCredentialNames: string[] = []
  private instanceId?: string
  private get log() {
    return createLogger(this.strategyId, this.instanceId !== undefined ? { instanceId: this.instanceId } : undefined)
  }

  constructor(options?: StrategyOptions) {
    this.dataDir = getDataDir(options?.dataDir)
    // Always constructed: llm slots need no class-level opt-in. options.llm
    // remains for code-registered custom providers and a legacy defaultModel.
    this.llmClient = new LlmClient(options?.llm)
    // Decorator-declared dependencies (@monitor/@executor/@account). Subclass
    // field initializers run after this constructor, so explicit declarations
    // override decorator metadata.
    const decorated = decoratedDeclarations(new.target)
    if (decorated) {
      if (decorated.id !== undefined) this.strategyId = decorated.id
      if (decorated.monitors.length > 0) this.monitors = decorated.monitors
      if (decorated.executors.length > 0) this.executors = decorated.executors
      if (decorated.accounts.length > 0) this.accounts = decorated.accounts
      if (decorated.llms.length > 0) this.llms = decorated.llms
    }
  }

  /**
   * Validate a monitor declaration by label or index and return its label.
   * Strategies speak in labels only — the runtime maps labels to registry keys
   * at activation, so no namespace knowledge is needed here.
   * Labels autocomplete when the declarations are `as const`.
   *
   * @example
   * sources: [{ monitorName: this.monitor('trades'), key: targetAddress }]
   */
  monitor(labelOrIndex: MonitorLabel<TDecl> | number): string {
    return this._resolveLabel(this.monitors, labelOrIndex as string | number, 'monitor')
  }

  /**
   * Validate an executor declaration by label or index and return its label.
   * TriggerManager rewrites the label to the executor's registry key when the
   * instruction is queued. Labels autocomplete when the declarations are `as const`.
   *
   * @example
   * { executorId: this.executor('perp'), action: 'placeOrder', ... }
   */
  executor(labelOrIndex: ExecutorLabel<TDecl> | number): string {
    return this._resolveLabel(this.executors, labelOrIndex as string | number, 'executor')
  }

  /** Resolve a declaration by label or index to its label, throwing on unknown declarations. */
  private _resolveLabel(
    declarations: readonly MonitorDeclaration[],
    labelOrIndex: string | number,
    kind: string,
  ): string {
    if (typeof labelOrIndex === 'number') {
      const decl = declarations[labelOrIndex]
      if (!decl) throw new Error(`${kind}[${labelOrIndex}] not declared in strategy "${this.strategyId}"`)
      return typeof decl === 'string' ? decl : decl.label
    }
    const decl = declarations.find(d =>
      typeof d === 'string' ? d === labelOrIndex : d.label === labelOrIndex
    )
    if (!decl) throw new Error(`${kind} with label '${labelOrIndex}' not declared in strategy "${this.strategyId}"`)
    return typeof decl === 'string' ? decl : decl.label
  }

  setMonitorReader(label: string, reader: MonitorDataReader): void {
    this.monitorReaders.set(label, reader)
  }

  setCredentialStore(store: CredentialStore): void {
    this.credentialStore = store
  }

  setStore(store: IStrategyStore): void {
    this.storeInstance = store
  }

  setHttpClient(client: HttpClient): void {
    this.httpClient = client
  }

  setParams(params: StrategyParams): void {
    this.injectedParams = params
  }

  setLlmBindings(bindings: Record<string, LlmSlotBinding>): void {
    this.llmBindings = bindings
  }

  setInstanceId(instanceId: string): void {
    this.instanceId = instanceId
  }

  setReaders(readers: unknown[], credentialNames: string[]): void {
    this.injectedReaders = readers
    this.injectedCredentialNames = credentialNames
  }

  private injectedAccountMeta: AccountSlotMeta[] = []

  setAccountMeta(metas: AccountSlotMeta[]): void {
    this.injectedAccountMeta = metas
  }

  /**
   * Facts about a bound account slot (name/venue/kind) — available from
   * triggers() onward. Use accountVenue() for the common case: venue-scoped
   * monitor keys derive from the binding instead of a duplicated parameter.
   */
  protected accountMeta(label: string): AccountSlotMeta {
    const meta = this.injectedAccountMeta.find(m => m.label === label)
    if (!meta) {
      throw new Error(
        `No account meta for slot '${label}' — it is injected at activation; ` +
        'triggers()/evaluate() may use it, constructors may not'
      )
    }
    return meta
  }

  /** The venue of the account bound to a slot ('binance', 'hyperliquid', …). */
  protected accountVenue(label: string): string {
    return this.accountMeta(label).venue
  }

  /** Returns the triggers this strategy needs. Override in subclass. Default: no triggers. */
  triggers(_params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return []
  }

  /**
   * Monitors to keep running without being woken by them. Override when the
   * strategy needs a monitor's data but decides on its own schedule — see
   * IStrategy.subscriptions. Default: none.
   */
  subscriptions(_params: StrategyParams): MonitorSource[] {
    return []
  }

  // ── Run tracing ─────────────────────────────────────────────────────────
  // Every run() assembles a step-by-step trace: what the strategy saw, what
  // each gate decided, what was finally emitted. Strategies add their own
  // steps via this.trace(); outside a run (previews, tests) trace() is a
  // no-op, so instrumentation costs nothing there.
  private runTraces: StrategyRunTrace[] = []

  private activeTraceSteps: Array<{ ts: number; step: string; data?: Record<string, unknown> }> | null = null

  private runSink: ((run: StrategyRunTrace) => void) | null = null

  /** Runtime-injected persistence for finished runs; must never throw into the run path. */
  setRunSink(sink: ((run: StrategyRunTrace) => void) | null): void {
    this.runSink = sink
  }

  /** Record one decision step of the current run. No-op outside run(). */
  protected trace(step: string, data?: Record<string, unknown>): void {
    if (!this.activeTraceSteps) return
    this.activeTraceSteps.push({ ts: Date.now(), step, ...(data !== undefined ? { data } : {}) })
  }

  /** The last runs' traces, newest first — the dashboard's audit view. */
  getRecentRuns(): typeof this.runTraces {
    return this.runTraces
  }

  async run(context: StrategyContext): Promise<ExecutionInstruction[]> {
    this.metrics.runsTotal++
    this.metrics.lastRunAt = Date.now()
    this.stepCache.clear()
    this.log.debug({ triggerId: context.triggerId }, 'Strategy run started')
    const startedAt = Date.now()
    this.activeTraceSteps = []
    // Everything the process logs to the console during this run lands in the
    // trace too — over-inclusive by design (concurrent runs of OTHER instances
    // will interleave, each line carries its module), because a silent trace
    // is worse than a noisy one.
    const unsubLogs = subscribeLogs((rec) => {
      this.activeTraceSteps?.push({
        ts: rec.ts, step: `log:${rec.level}`,
        data: { ...(rec.module !== undefined ? { module: rec.module } : {}), msg: rec.msg, ...rec.extra },
      })
    })
    this.trace('run:triggered', { triggerId: context.triggerId, monitorData: Object.keys(context.monitorData ?? {}) })
    const finish = (instructions: number, error?: string) => {
      const rec: StrategyRunTrace = {
        startedAt, triggerId: context.triggerId, durationMs: Date.now() - startedAt,
        instructions, ...(error !== undefined ? { error } : {}),
        steps: this.activeTraceSteps ?? [],
      }
      this.runTraces.unshift(rec)
      if (this.runTraces.length > 50) this.runTraces.length = 50
      this.activeTraceSteps = null
      unsubLogs()
      try { this.runSink?.(rec) } catch { /* persistence must not fail the run */ }
    }
    try {
      const instructions = await this.evaluate(context)
      this.metrics.instructionsEmitted += instructions.length
      this.log.debug({ triggerId: context.triggerId, instructionCount: instructions.length }, 'Strategy run completed')
      finish(instructions.length)
      return instructions
    } catch (err) {
      this.metrics.errors++
      this.log.error({ triggerId: context.triggerId, err }, 'Strategy run failed')
      finish(0, err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  abstract evaluate(context: StrategyContext): Promise<ExecutionInstruction[]>

  getMetrics(): StrategyMetrics {
    return { ...this.metrics }
  }

  // ── Decision helpers ──────────────────────────────────────────────────────

  protected rule(condition: boolean, instructions: ExecutionInstruction[]): ExecutionInstruction[] {
    return condition ? instructions : []
  }

  protected async step<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.stepCache.has(key)) return this.stepCache.get(key) as T
    const result = await fn()
    this.stepCache.set(key, result)
    return result
  }

  protected parallel(instructionSets: ExecutionInstruction[][]): ExecutionInstruction[] {
    return instructionSets.flat()
  }

  protected forEach<T>(
    items: T[],
    fn: (item: T) => ExecutionInstruction[]
  ): ExecutionInstruction[] {
    return items.flatMap(fn)
  }

  protected when(
    condition: boolean,
    thenInstructions: ExecutionInstruction[],
    elseInstructions: ExecutionInstruction[] = []
  ): ExecutionInstruction[] {
    return condition ? thenInstructions : elseInstructions
  }

  // ── Data access ───────────────────────────────────────────────────────────

  /**
   * Returns the MonitorDataReader for the given monitor label or index.
   * Use reader.readLast(key, n), reader.keys(), reader.readAllLatest() etc.
   *
   * @example
   * const reader = this.monitorData('trades')
   * const latest = await reader?.readLatest('BTC')
   */
  protected monitorData(labelOrIndex: MonitorLabel<TDecl> | number): MonitorDataReader | undefined {
    const label = this._resolveLabel(this.monitors, labelOrIndex as string | number, 'monitor')
    return this.monitorReaders.get(label)
  }

  /**
   * Build an ExecutionInstruction for a declared executor.
   *
   * @param accountLabels - Labels (or indices) of this strategy's account slots
   *   whose bound credentials the executor should use, in the order of the
   *   executor's session slots. Omit to use the executor's instance-level bindings.
   *
   * @example
   * return [this.instruction('perp', 'placeOrder', { symbol: 'BTC', side: 'buy', ... }, ['main'])]
   */
  protected instruction(
    executorLabelOrIndex: ExecutorLabel<TDecl> | number,
    action: string,
    params: Record<string, unknown>,
    accountLabels?: (AccountLabel<TDecl> | number)[],
  ): ExecutionInstruction {
    const accountNames = accountLabels?.map((labelOrIdx) => this._accountSlot(labelOrIdx as string | number).credentialName)
    return {
      executorId: this.executor(executorLabelOrIndex),
      messageId: nanoid(),
      action,
      params,
      ...(this.instanceId ? { instanceId: this.instanceId } : {}),
      ...(accountNames && accountNames.length > 0 ? { accountNames } : {}),
    }
  }

  protected async credential(name: string): Promise<CredentialData> {
    if (!this.credentialStore) throw new Error('CredentialStore not configured')
    return this.credentialStore.getByName(name)
  }

  /**
   * Access injected params. Available after activate() injects them.
   */
  protected get params(): StrategyParams {
    if (!this.injectedParams) throw new Error('Params not injected — strategy not yet activated')
    return this.injectedParams
  }

  /**
   * Access the Reader of an account slot, by label or index.
   *
   * The Reader type follows the declaration's class reference — declaring a
   * venue subclass surfaces its extra typed methods. Strategies only ever hold
   * Readers: the underlying session (write-capable venue connection) is
   * structurally unreachable from strategy code.
   *
   * @example
   * const reader = this.account('main')        // e.g. PerpAccount
   * const positions = await reader.positions()
   */
  protected account<L extends AccountLabel<TDecl> | number>(
    indexOrLabel: L,
  ): L extends number ? unknown : ReaderOfLabel<TDecl, L> {
    return this._accountSlot(indexOrLabel as string | number).reader as never
  }

  /** Resolve an account slot (by label or index) to its injected reader and credential name. */
  private _accountSlot(indexOrLabel: string | number): { reader: unknown; credentialName: string } {
    const index = typeof indexOrLabel === 'number'
      ? indexOrLabel
      : this.accounts.findIndex(d => d.label === indexOrLabel)
    const reader = this.injectedReaders[index]
    const credentialName = this.injectedCredentialNames[index]
    if (index < 0 || reader === undefined || credentialName === undefined) {
      throw new Error(`Account slot '${indexOrLabel}' not found in strategy "${this.strategyId}"`)
    }
    return { reader, credentialName }
  }

  /**
   * Bundle-scoped persistent KV store. Values survive process restarts.
   * Backed by SQL (DBStrategyStore) when a DatabaseAdapter is configured.
   *
   * @example
   * await this.store.set('lastPrice', 50000)
   * const last = await this.store.get<number>('lastPrice')
   */
  protected get store(): IStrategyStore {
    if (!this.storeInstance) throw new Error('StrategyStore not configured — make sure the runtime has a DatabaseAdapter')
    return this.storeInstance
  }

  /**
   * Controlled HTTP client. All requests are logged for observability.
   * Use this instead of calling fetch directly.
   *
   * @example
   * const res = await this.http.get<{ price: number }>('https://api.example.com/price')
   * const res = await this.http.post('https://api.example.com/order', { side: 'buy' })
   */
  protected get http(): HttpClient {
    if (!this.httpClient) throw new Error('HttpClient not configured')
    return this.httpClient
  }

  // ── LLM inference ─────────────────────────────────────────────────────────

  /**
   * Call an LLM with structured output. Returns the parsed object typed by the schema.
   *
   * @example
   * const result = await this.llm({
   *   messages: [{ role: 'user', content: 'Analyse this data...' }],
   *   schema: z.object({ action: z.enum(['buy', 'sell', 'hold']) }),
   * })
   * // result: { action: 'buy' | 'sell' | 'hold' }
   */
  protected async llm<TSchema extends ZodType>(
    options: LlmCallOptions<TSchema>
  ): Promise<import('zod').infer<TSchema>>

  /**
   * Call an LLM for plain text output.
   *
   * @example
   * const summary = await this.llm({ messages: [{ role: 'user', content: 'Summarise...' }] })
   * // summary: string
   */
  protected async llm(options: LlmCallOptions<undefined>): Promise<string>

  /**
   * Call a declared LLM slot by label. Config merges declaration defaults ←
   * instance bindings ← this call's options.
   *
   * @example
   * const decision = await this.llm('decision', { messages, schema })
   */
  protected async llm<TSchema extends ZodType>(
    label: LlmLabel<TDecl>,
    options: LlmCallOptions<TSchema>
  ): Promise<import('zod').infer<TSchema>>
  protected async llm(label: LlmLabel<TDecl>, options: LlmCallOptions<undefined>): Promise<string>

  protected async llm<TSchema extends ZodType | undefined>(
    labelOrOptions: LlmLabel<TDecl> | LlmCallOptions<TSchema>,
    maybeOptions?: LlmCallOptions<TSchema>,
  ): Promise<TSchema extends ZodType ? import('zod').infer<TSchema> : string> {
    if (!this.credentialStore) {
      throw new Error('llm() requires a CredentialStore — make sure the runtime has injected one.')
    }
    const label = typeof labelOrOptions === 'string' ? labelOrOptions : undefined
    const options = (typeof labelOrOptions === 'string' ? maybeOptions : labelOrOptions)!
    const slot = this._llmSlotConfig(label, options)
    return this.llmClient.call({
      ...options,
      ...(slot.model !== undefined ? { model: slot.model } : {}),
      ...(slot.credentialName !== undefined ? { credentialName: slot.credentialName } : {}),
      ...(Object.keys(slot.settings).length > 0 ? { settings: slot.settings } : {}),
    }, this.credentialStore)
  }

  /**
   * ESCAPE HATCH: resolve a declared LLM slot to a raw AI SDK LanguageModel
   * (key injected). Use it with any AI SDK function directly — streamText,
   * embed, agent loops — the framework only handles credentials and slot
   * config; the capability surface is the AI SDK itself.
   *
   * @example
   * const model = await this.llmModel('decision')
   * const stream = streamText({ model, messages })
   */
  protected async llmModel(label?: LlmLabel<TDecl>): Promise<LanguageModel> {
    if (!this.credentialStore) {
      throw new Error('llmModel() requires a CredentialStore — make sure the runtime has injected one.')
    }
    const slot = this._llmSlotConfig(label)
    if (!slot.model) {
      throw new Error(label
        ? `LLM slot '${String(label)}' has no model configured`
        : 'llmModel() without a label needs a declared llm slot or a defaultModel')
    }
    return this.llmClient.resolveModel(slot.model, this.credentialStore, slot.credentialName)
  }

  /** Merge one slot's config: declaration defaults ← instance binding ← call overrides. */
  private _llmSlotConfig(
    label: string | undefined,
    call?: { model?: string; credentialName?: string; settings?: LlmCallSettings },
  ): { model?: string; credentialName?: string; settings: LlmCallSettings } {
    let declaration: LlmDeclaration | undefined
    if (label !== undefined) {
      declaration = this.llms.find(d => d.label === label)
      if (!declaration) throw new Error(`llm slot '${label}' not declared in strategy "${this.strategyId}"`)
    } else if (this.llms.length === 1) {
      // A single declared slot is unambiguous — label may be omitted
      declaration = this.llms[0]
    }
    const binding = declaration ? this.llmBindings[declaration.label] : undefined
    const model = call?.model ?? binding?.model ?? declaration?.model
    const credentialName = call?.credentialName ?? binding?.credentialName ?? declaration?.credentialName
    return {
      ...(model !== undefined ? { model } : {}),
      ...(credentialName !== undefined ? { credentialName } : {}),
      settings: { ...declaration?.settings, ...binding?.settings, ...call?.settings },
    }
  }
}

