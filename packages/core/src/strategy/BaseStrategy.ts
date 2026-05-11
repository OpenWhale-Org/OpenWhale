import type { ExecutionInstruction } from '../types/executor.js'
import type { IStrategy, StrategyContext, StrategyMetrics, StrategyOptions, AccountTypeDeclaration } from '../types/strategy.js'
import type { MonitorDataReader } from '../types/monitor.js'
import type { CredentialStore, CredentialData } from '../types/credential.js'
import type { IStrategyStore } from './StrategyStore.js'
import type { ZodType } from 'zod'
import type { Trigger } from '../types/trigger.js'
import type { StrategyParams } from '../types/instance.js'
import type { IAccount } from '../types/account.js'
import { z } from 'zod'
import { getDataDir } from '../utils/paths.js'
import { createLogger } from '../utils/logger.js'
import { LlmClient } from './llm.js'
import type { CoreMessage, LlmCallOptions } from './llm.js'
import { HttpClient } from './HttpClient.js'

export type { CoreMessage }

/**
 * @ai-guide 如何编写一个 Strategy
 *
 * Strategy 负责：接收触发上下文 → 决策 → 返回一批 ExecutionInstruction。
 * 子类只需实现 `evaluate(context)`，基类提供决策辅助、数据访问和 LLM 推理能力。
 *
 * 基本示例：
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
 * 使用 LLM 推理（结构化输出）：
 * ```typescript
 * class AiStrategy extends BaseStrategy {
 *   readonly strategyId = 'ai-strategy'
 *
 *   constructor() {
 *     super({ llm: { defaultModel: 'openai:gpt-4o' } })
 *     // 需要在 CredentialStore 中存储 'openai-api-key'
 *   }
 *
 *   async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
 *     const data = await this.monitorData('market')?.getLatest()
 *
 *     const decision = await this.llm({
 *       messages: [
 *         { role: 'system', content: '你是一个交易分析师，根据市场数据给出操作建议。' },
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
 * 使用自定义 Provider：
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
  /** Declare monitor dependencies. TriggerManager injects a reader for each at startup. */
  readonly monitors: readonly string[] = []
  /** Declare account type requirements. Framework validates and injects accounts at activate() time. */
  readonly accountTypes: readonly AccountTypeDeclaration[] = []

  /** Base params schema (required, no defaults). Override in subclass. */
  readonly baseParamsSchema: z.ZodObject<z.ZodRawShape> = z.object({})
  /** Tunable params schema (AI-optimizable, all fields must have .default()). Override in subclass. */
  readonly tunableParamsSchema: z.ZodObject<z.ZodRawShape> = z.object({})

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
  private get log() { return createLogger(this.strategyId) }

  constructor(options?: StrategyOptions) {
    this.dataDir = getDataDir(options?.dataDir)
    if (options?.llm) {
      this.llmClient = new LlmClient(options.llm)
    }
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
   * Returns the MonitorDataReader for the given monitor name.
   * Use reader.readLast(key, n), reader.keys(), reader.readAllLatest() etc.
   *
   * @example
   * const reader = this.monitorData('price')
   * const latest = await reader?.readLatest('BTC')
   * const all = await reader?.readAllLatest()
   */
  protected monitorData(monitorName: string): MonitorDataReader | undefined {
    return this.monitorReaders.get(monitorName)
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

