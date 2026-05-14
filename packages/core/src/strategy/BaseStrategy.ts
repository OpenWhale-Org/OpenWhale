import type { ExecutionInstruction } from '../types/executor.js'
import type { IStrategy, StrategyContext, StrategyMetrics, StrategyOptions, AccountTypeDeclaration, MonitorDeclaration, ExecutorDeclaration } from '../types/strategy.js'
import type { MonitorDataReader } from '../types/monitor.js'
import type { CredentialStore, CredentialData } from '../types/credential.js'
import type { IStrategyStore } from './StrategyStore.js'
import type { ZodType, ZodRawShape } from 'zod'
import type { Trigger } from '../types/trigger.js'
import type { StrategyParams } from '../types/instance.js'
import type { IAccount } from '../types/account.js'
import type { ParamFieldDef, ParamFieldMeta, ParamFieldType } from '../types/definition.js'
import { z } from 'zod'
import { nanoid } from 'nanoid'
import { getDataDir } from '../utils/paths.js'
import { createLogger } from '../utils/logger.js'
import { LlmClient } from './llm.js'
import type { CoreMessage, LlmCallOptions } from './llm.js'
import { HttpClient } from './HttpClient.js'

export type { CoreMessage }

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
export abstract class BaseStrategy implements IStrategy {
  abstract readonly strategyId: string
  /** Declare monitor dependencies. Use `{ name, label }` for named access, or plain string for name=label. */
  readonly monitors: readonly MonitorDeclaration[] = []
  /** Declare executor dependencies. Use `{ name, label }` for named access, or plain string for name=label. */
  readonly executors: readonly ExecutorDeclaration[] = []
  /** Declare account type requirements. Framework validates and injects accounts at activate() time. */
  readonly accountTypes: readonly AccountTypeDeclaration[] = []

  /** Base params schema (required, no defaults). Override in subclass. */
  readonly baseParamsSchema: z.ZodObject<z.ZodRawShape> = z.object({})
  /** Tunable params schema (AI-optimizable, all fields must have .default()). Override in subclass. */
  readonly tunableParamsSchema: z.ZodObject<z.ZodRawShape> = z.object({})

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

    function processShape(shape: ZodRawShape, group: 'base' | 'tunable') {
      for (const [name, rawField] of Object.entries(shape)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let field: any = rawField
        let defaultValue: unknown = undefined
        let required = group === 'base'

        // Read meta from the outermost wrapper first (covers .default().meta() pattern)
        let meta: ParamFieldMeta = field.meta?.() ?? {}

        // Unwrap ZodDefault to get the inner type and default value
        if (field.type === 'default') {
          defaultValue = typeof field.def.defaultValue === 'function'
            ? field.def.defaultValue()
            : field.def.defaultValue
          field = field.def.innerType
          required = false
          // If meta was empty on the wrapper, try the inner type (.meta().default() pattern)
          if (Object.keys(meta).length === 0) meta = field.meta?.() ?? {}
        }

        // Unwrap ZodOptional
        if (field.type === 'optional') {
          field = field.def.innerType
          required = false
          if (Object.keys(meta).length === 0) meta = field.meta?.() ?? {}
        }

        const zodType: string = field.type ?? ''
        const fieldType = BaseStrategy.zodTypeToParamFieldType(zodType, meta)

        fields.push({
          name,
          displayName: meta.displayName ?? name,
          type: fieldType,
          group,
          ...(defaultValue !== undefined ? { default: defaultValue } : {}),
          ...(required ? { required: true } : {}),
          ...(meta.description ? { description: meta.description } : {}),
          ...(meta.hint ? { hint: meta.hint } : {}),
          ...(meta.placeholder ? { placeholder: meta.placeholder } : {}),
          ...(meta.options ? { options: meta.options } : {}),
          ...(meta.displayOptions ? { displayOptions: meta.displayOptions } : {}),
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
  private readonly llmClient?: LlmClient
  private injectedParams?: StrategyParams
  private injectedAccounts: IAccount[] = []
  private namespace?: string
  private instanceId?: string
  private get log() { return createLogger(this.strategyId) }

  constructor(options?: StrategyOptions) {
    this.dataDir = getDataDir(options?.dataDir)
    if (options?.llm) {
      this.llmClient = new LlmClient(options.llm)
    }
  }

  get resolvedMonitors(): readonly string[] {
    return this.monitors.map(m => this._resolveDeclarationName(typeof m === 'string' ? m : m.name))
  }

  get resolvedExecutors(): readonly string[] {
    return this.executors.map(e => this._resolveDeclarationName(typeof e === 'string' ? e : e.name))
  }

  /**
   * Called by loadPlugin() to inject the plugin namespace (e.g. 'hyperliquid').
   * After this, monitor/executor names without '/' are resolved as '{namespace}/{name}'.
   */
  setPrefixedNames(namespace: string): void {
    this.namespace = namespace
  }

  /**
   * Resolve a monitor declaration by label or index to its registry key.
   * Use this in triggers() to reference monitors without hardcoding registry keys.
   *
   * @example
   * sources: [{ monitorName: this.monitor('trades'), key: targetAddress }]
   */
  monitor(labelOrIndex: string | number): string {
    return this._resolveDeclaration(this.monitors, labelOrIndex, 'monitor')
  }

  /**
   * Resolve an executor declaration by label or index to its registry key.
   * Use this in evaluate() to build ExecutionInstructions without hardcoding executor ids.
   *
   * @example
   * { executorId: this.executor('perp'), action: 'placeOrder', ... }
   */
  executor(labelOrIndex: string | number): string {
    return this._resolveDeclaration(this.executors, labelOrIndex, 'executor')
  }

  /** Resolve a declaration name: if it contains '/', use as-is; otherwise prepend namespace. */
  private _resolveDeclarationName(name: string): string {
    if (name.includes('/')) return name
    return this.namespace ? `${this.namespace}/${name}` : name
  }

  private _resolveDeclaration(
    declarations: readonly MonitorDeclaration[],
    labelOrIndex: string | number,
    kind: string,
  ): string {
    if (typeof labelOrIndex === 'number') {
      const decl = declarations[labelOrIndex]
      if (!decl) throw new Error(`${kind}[${labelOrIndex}] not declared in strategy "${this.strategyId}"`)
      const name = typeof decl === 'string' ? decl : decl.name
      return this._resolveDeclarationName(name)
    }
    const decl = declarations.find(d =>
      typeof d === 'string' ? d === labelOrIndex : d.label === labelOrIndex
    )
    if (!decl) throw new Error(`${kind} with label '${labelOrIndex}' not declared in strategy "${this.strategyId}"`)
    const name = typeof decl === 'string' ? decl : decl.name
    return this._resolveDeclarationName(name)
  }

  /** Resolve a monitor label/index to the key used in monitorReaders and context.monitorData. */
  private _resolveMonitorLabel(labelOrIndex: string | number): string {
    const declarations = this.monitors
    if (typeof labelOrIndex === 'number') {
      const decl = declarations[labelOrIndex]
      if (!decl) throw new Error(`monitor[${labelOrIndex}] not declared in strategy "${this.strategyId}"`)
      return typeof decl === 'string' ? decl : decl.label
    }
    const decl = declarations.find(d =>
      typeof d === 'string' ? d === labelOrIndex : d.label === labelOrIndex
    )
    if (!decl) throw new Error(`monitor with label '${labelOrIndex}' not declared in strategy "${this.strategyId}"`)
    return typeof decl === 'string' ? decl : decl.label
  }

  setMonitorReader(key: string, reader: MonitorDataReader): void {
    this.monitorReaders.set(key, reader)
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

  setInstanceId(instanceId: string): void {
    this.instanceId = instanceId
  }

  setAccounts(accounts: IAccount[]): void {
    this.injectedAccounts = accounts
  }

  /** Returns the triggers this strategy needs. Override in subclass. Default: no triggers. */
  triggers(_params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return []
  }

  async run(context: StrategyContext): Promise<ExecutionInstruction[]> {
    this.metrics.runsTotal++
    this.metrics.lastRunAt = Date.now()
    this.stepCache.clear()
    this.log.debug({ triggerId: context.triggerId }, 'Strategy run started')
    try {
      const instructions = await this.evaluate(context)
      this.metrics.instructionsEmitted += instructions.length
      this.log.debug({ triggerId: context.triggerId, instructionCount: instructions.length }, 'Strategy run completed')
      return instructions
    } catch (err) {
      this.metrics.errors++
      this.log.error({ triggerId: context.triggerId, err }, 'Strategy run failed')
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
  protected monitorData(labelOrIndex: string | number): MonitorDataReader | undefined {
    const registryKey = this._resolveDeclaration(this.monitors, labelOrIndex, 'monitor')
    return this.monitorReaders.get(registryKey)
  }

  /**
   * Build an ExecutionInstruction for a declared executor.
   *
   * @param accountLabels - Labels (or indices) of accounts from this strategy's accountTypes
   *   to pass to the executor, in the order the executor's accountTypes expects them.
   *
   * @example
   * return [this.instruction('perp', 'placeOrder', { symbol: 'BTC', side: 'buy', ... }, ['main'])]
   */
  protected instruction(
    executorLabelOrIndex: string | number,
    action: string,
    params: Record<string, unknown>,
    accountLabels?: (string | number)[],
  ): ExecutionInstruction {
    const accountNames = accountLabels?.map((labelOrIdx) => this.account(labelOrIdx).name)
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
   * Access an injected account by index or label.
   * Cast to a platform-specific interface for extended fields.
   *
   * @example
   * const hl = this.account<IPerpAccount>(0)
   * const hl = this.account<IPerpAccount>('main')  // requires label in accountTypes
   */
  protected account<T extends IAccount = IAccount>(indexOrLabel: number | string): T {
    if (typeof indexOrLabel === 'number') {
      const acc = this.injectedAccounts[indexOrLabel]
      if (!acc) throw new Error(`Account at index ${indexOrLabel} not found`)
      return acc as T
    }
    const acc = this.injectedAccounts.find((a) => {
      const decl = this.accountTypes[this.injectedAccounts.indexOf(a)]
      return typeof decl === 'object' && decl.label === indexOrLabel
    })
    if (!acc) throw new Error(`Account with label '${indexOrLabel}' not found`)
    return acc as T
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

  protected async llm<TSchema extends ZodType | undefined>(
    options: LlmCallOptions<TSchema>
  ): Promise<TSchema extends ZodType ? import('zod').infer<TSchema> : string> {
    if (!this.llmClient) {
      throw new Error(
        `llm() called but no LLM is configured. Pass 'llm: { defaultModel: "provider:model" }' in StrategyOptions.`
      )
    }
    if (!this.credentialStore) {
      throw new Error('llm() requires a CredentialStore — make sure the runtime has injected one.')
    }
    return this.llmClient.call(options, this.credentialStore)
  }
}

