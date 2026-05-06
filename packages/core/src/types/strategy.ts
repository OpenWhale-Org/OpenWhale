import type { ExecutionInstruction } from './executor.js'
import type { MonitorDataReader } from './monitor.js'
import type { CredentialStore } from './credential.js'
import type { RetryOptions } from './executor.js'

export interface StrategyContext {
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

export interface IStrategy {
  readonly strategyId: string
  /** Monitor names this strategy depends on. TriggerManager injects readers for these at startup. */
  readonly monitors: readonly string[]
  run(context: StrategyContext): Promise<ExecutionInstruction[]>
  getMetrics(): StrategyMetrics
  setMonitorReader(key: string, reader: MonitorDataReader): void
  setCredentialStore(store: CredentialStore): void
}
