import type { ExecutionInstruction } from './executor.js'
import type { MonitorDataReader } from './monitor.js'
import type { CredentialStore } from './credential.js'
import type { RetryOptions } from './executor.js'
import type { IStrategyStore } from '../strategy/StrategyStore.js'
import type { HttpClient } from '../strategy/HttpClient.js'
import type { Trigger } from './trigger.js'
import type { StrategyParams } from './instance.js'
import type { IAccount } from './account.js'
import type { ZodObject, ZodRawShape } from 'zod'
import type { ParamFieldDef } from './definition.js'

export interface StrategyContext {
  instanceId: string
  triggerId: string
  /** Flattened monitor data at the time of trigger, keyed by 'monitorName:key'. Empty for pure cron triggers. */
  monitorData: Record<string, Record<string, unknown>>
  timestamp: number
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

/** Account type declaration: simple string or with a label for named access. */
export type AccountTypeDeclaration = string | { type: string; label: string }

export interface IStrategy {
  readonly strategyId: string
  /** Monitor names this strategy depends on. TriggerManager injects readers for these at startup. */
  readonly monitors: readonly string[]
  /** Account type declarations. Framework validates and injects accounts at activate() time. */
  readonly accountTypes: readonly AccountTypeDeclaration[]
  /** Base params schema (required fields, no defaults). */
  readonly baseParamsSchema: ZodObject<ZodRawShape>
  /** Tunable params schema (AI-optimizable, all fields must have .default()). */
  readonly tunableParamsSchema: ZodObject<ZodRawShape>
  /** Field descriptors for generic UI rendering. Optional. */
  readonly paramsFields?: ParamFieldDef[]
  /** Returns the triggers this strategy needs, given its params. Framework fills id/strategyInstanceId. */
  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[]
  run(context: StrategyContext): Promise<ExecutionInstruction[]>
  getMetrics(): StrategyMetrics
  setMonitorReader(key: string, reader: MonitorDataReader): void
  setCredentialStore(store: CredentialStore): void
  setStore(store: IStrategyStore): void
  setHttpClient(client: HttpClient): void
  setParams(params: StrategyParams): void
  setAccounts(accounts: IAccount[]): void
}
