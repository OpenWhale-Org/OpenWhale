import { generateText, generateObject, stepCountIs } from 'ai'
import type { ToolSet, StepResult } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { ModelMessage, LanguageModel } from 'ai'
import { z } from 'zod'
import type { ZodType } from 'zod'
import type { BuiltinProviderId, LlmOptions, ProviderConfig, BuiltinProviderConfig } from '../types/strategy.js'
import type { RetryOptions } from '../types/executor.js'
import type { CredentialStore } from '../types/credential.js'

export type { ModelMessage as CoreMessage }

/**
 * Legacy magic credential names — the pre-typed-credentials lookup, kept as a
 * deprecated fallback. New credentials use TYPED entries instead: type
 * 'anthropic' / 'openai' / 'google' / 'openai-compatible' with data { apiKey }.
 */
export const BUILTIN_CREDENTIAL_NAMES: Record<BuiltinProviderId, string> = {
  openai:    'openai-api-key',
  anthropic: 'anthropic-api-key',
  google:    'google-api-key',
  mistral:   'mistral-api-key',
  cohere:    'cohere-api-key',
  groq:      'groq-api-key',
  xai:       'xai-api-key',
}

interface ResolvedCredential {
  apiKey: string
  baseURL?: string
}

/** Factory functions for built-in providers. Each returns (modelId) => LanguageModel. */
const BUILTIN_FACTORIES: Record<string, (cred: ResolvedCredential) => (modelId: string) => LanguageModel> = {
  openai:    (c) => (modelId) => createOpenAI({ apiKey: c.apiKey })(modelId),
  anthropic: (c) => (modelId) => createAnthropic({ apiKey: c.apiKey })(modelId),
  google:    (c) => (modelId) => createGoogleGenerativeAI({ apiKey: c.apiKey })(modelId),
  // .chat(): third-party endpoints implement chat completions, not OpenAI's
  // newer Responses API (the provider callable's default).
  'openai-compatible': (c) => (modelId) => createOpenAI({ apiKey: c.apiKey, ...(c.baseURL ? { baseURL: c.baseURL } : {}) }).chat(modelId),
  'anthropic-compatible': (c) => (modelId) => createAnthropic({ apiKey: c.apiKey, ...(c.baseURL ? { baseURL: c.baseURL } : {}) })(modelId),
}

/**
 * AI SDK call settings, passed through VERBATIM to generateText/generateObject
 * (temperature, maxOutputTokens, topP, stopSequences, seed, headers,
 * providerOptions, …). Deliberately untyped: the framework does not curate the
 * AI SDK surface.
 */
export type LlmCallSettings = Record<string, unknown>

export interface LlmCallOptions<TSchema extends ZodType | undefined = undefined> {
  messages: ModelMessage[]
  /** Override the model. Format: `'provider:model'`. */
  model?: string
  /** Pin a specific credential by name (needed when several of one type exist). */
  credentialName?: string
  /** AI SDK settings passthrough. */
  settings?: LlmCallSettings
  schema?: TSchema
  retry?: Partial<RetryOptions>
}

export interface LlmToolCallOptions<TOOLS extends ToolSet = ToolSet> {
  messages: ModelMessage[]
  model?: string
  credentialName?: string
  settings?: LlmCallSettings
  system?: string
  /** AI SDK tool set (build with `tool()` from 'ai'). */
  tools: TOOLS
  /** Max agent steps before the loop is stopped. Default 16. */
  maxSteps?: number
  /** Per-step callback — progress reporting for long agent runs. */
  onStepFinish?: (step: StepResult<TOOLS>) => void | Promise<void>
}

type LlmResult<TSchema extends ZodType | undefined> =
  TSchema extends ZodType ? import('zod').infer<TSchema> : string

/**
 * LLM access for one consumer (a strategy instance or the compiler).
 *
 * Credential resolution, per provider id:
 *   1. explicit credentialName (call/binding/config)      → getByName
 *   2. exactly one stored credential of that TYPE          → use it
 *      several                                             → error listing names
 *   3. legacy magic name '{provider}-api-key'              → deprecated fallback
 *   4. otherwise                                           → guidance error
 *
 * No provider cache: factories are trivial to build, and cache-free means key
 * rotation takes effect immediately and multiple credentials never cross wires.
 */
export class LlmClient {
  private readonly options: LlmOptions

  constructor(options?: LlmOptions) {
    this.options = options ?? {}
  }

  async call<TSchema extends ZodType | undefined = undefined>(
    callOptions: LlmCallOptions<TSchema>,
    credentialStore: CredentialStore,
  ): Promise<LlmResult<TSchema>> {
    const modelString = callOptions.model ?? this.options.defaultModel
    if (!modelString) {
      throw new Error('No model specified. Pass model in the llm() call or configure a default.')
    }

    const model = await this.resolveModel(modelString, credentialStore, callOptions.credentialName)
    const providerId = modelString.slice(0, modelString.indexOf(':'))
    const retry = callOptions.retry
    const maxRetries = retry?.maxRetries ?? 0
    const retryDelay = retry?.retryDelay ?? 500
    const maxRetryDelay = retry?.maxRetryDelay ?? 30000

    return this.callWithRetry(model, providerId, callOptions, maxRetries, retryDelay, maxRetryDelay)
  }

  /**
   * Agentic tool loop: the model may call the provided tools across multiple
   * steps until it produces a final text answer or hits maxSteps.
   */
  async callWithTools<TOOLS extends ToolSet>(
    options: LlmToolCallOptions<TOOLS>,
    credentialStore: CredentialStore,
  ): Promise<{ text: string; steps: StepResult<TOOLS>[] }> {
    const modelString = options.model ?? this.options.defaultModel
    if (!modelString) {
      throw new Error('No model specified. Pass model in the callWithTools() call or configure a default.')
    }
    const model = await this.resolveModel(modelString, credentialStore, options.credentialName)

    const { text, steps } = await generateText({
      model,
      messages: options.messages,
      ...(options.system !== undefined ? { system: options.system } : {}),
      tools: options.tools,
      stopWhen: stepCountIs(options.maxSteps ?? 16),
      ...(options.onStepFinish !== undefined ? { onStepFinish: options.onStepFinish } : {}),
      ...(options.settings ?? {}),
    })
    return { text, steps }
  }

  private async callWithRetry<TSchema extends ZodType | undefined>(
    model: LanguageModel,
    providerId: string,
    callOptions: LlmCallOptions<TSchema>,
    maxRetries: number,
    retryDelay: number,
    maxRetryDelay: number,
  ): Promise<LlmResult<TSchema>> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.callOnce(model, providerId, callOptions)
      } catch (err) {
        lastError = err
        if (attempt < maxRetries) {
          const delay = Math.min(retryDelay * Math.pow(2, attempt), maxRetryDelay)
          await sleep(delay)
        }
      }
    }
    throw lastError
  }

  private async callOnce<TSchema extends ZodType | undefined>(
    model: LanguageModel,
    providerId: string,
    callOptions: LlmCallOptions<TSchema>,
  ): Promise<LlmResult<TSchema>> {
    const settings = callOptions.settings ?? {}
    if (callOptions.schema) {
      // OpenAI-compatible endpoints (DeepSeek, Ollama, proxies) reject the
      // json_schema response_format that generateObject forces on chat models.
      // Degrade to schema-in-prompt + parse — works on any endpoint.
      if (providerId === 'openai-compatible') {
        const jsonSchema = JSON.stringify(z.toJSONSchema(callOptions.schema as ZodType))
        const { text } = await generateText({
          model,
          messages: [
            {
              role: 'system',
              content: 'Respond with ONLY a single JSON object - no markdown fences, no prose. ' +
                `It must validate against this JSON Schema:\n${jsonSchema}`,
            },
            ...callOptions.messages,
          ],
          ...settings,
        })
        return (callOptions.schema as ZodType).parse(JSON.parse(extractJson(text))) as LlmResult<TSchema>
      }
      const { object } = await generateObject({
        model,
        messages: callOptions.messages,
        schema: callOptions.schema,
        ...settings,
      })
      return object as LlmResult<TSchema>
    }

    const { text } = await generateText({
      model,
      messages: callOptions.messages,
      ...settings,
    })
    return text as LlmResult<TSchema>
  }

  /**
   * Resolve `'provider:model'` (+ optional credential name) to a ready
   * LanguageModel with the key injected. PUBLIC: the escape hatch — hand the
   * result to any AI SDK function (streamText, embed, …) directly.
   */
  async resolveModel(
    modelString: string,
    credentialStore: CredentialStore,
    credentialName?: string,
  ): Promise<LanguageModel> {
    const colonIdx = modelString.indexOf(':')
    if (colonIdx === -1) {
      throw new Error(`Invalid model format: '${modelString}'. Expected 'provider:model', e.g. 'anthropic:claude-sonnet-5'.`)
    }
    const providerId = modelString.slice(0, colonIdx)
    const modelId = modelString.slice(colonIdx + 1)

    const providerFactory = await this.buildProviderFactory(providerId, credentialStore, credentialName)
    return providerFactory(modelId)
  }

  private async buildProviderFactory(
    providerId: string,
    credentialStore: CredentialStore,
    credentialName?: string,
  ): Promise<(modelId: string) => LanguageModel> {
    // Code-registered custom providers take precedence (StrategyOptions.llm.providers)
    const explicitConfig = this.options.providers?.find((p): p is ProviderConfig =>
      p.provider === 'custom' ? (p as { id: string }).id === providerId : p.provider === providerId
    )
    if (explicitConfig?.provider === 'custom') {
      const { data } = await credentialStore.getByName(credentialName ?? explicitConfig.credentialName)
      return explicitConfig.create((data['apiKey'] ?? data['value']) as string)
    }

    const factory = BUILTIN_FACTORIES[providerId]
    if (!factory) {
      throw new Error(`Unknown provider: '${providerId}'. Built-in: ${Object.keys(BUILTIN_FACTORIES).join(', ')} — or register a custom one via llm.providers.`)
    }

    const cred = await this.resolveCredential(
      providerId,
      credentialName ?? (explicitConfig as BuiltinProviderConfig | undefined)?.credentialName,
      credentialStore,
    )
    return factory(cred)
  }

  private async resolveCredential(
    providerId: string,
    credentialName: string | undefined,
    store: CredentialStore,
  ): Promise<ResolvedCredential> {
    const toResolved = (data: Record<string, unknown>): ResolvedCredential => {
      const apiKey = (data['apiKey'] ?? data['value']) as string | undefined
      if (!apiKey) throw new Error(`Credential has no apiKey field`)
      return { apiKey, ...(typeof data['baseURL'] === 'string' ? { baseURL: data['baseURL'] } : {}) }
    }

    if (credentialName) {
      const { data } = await store.getByName(credentialName)
      return toResolved(data)
    }

    // Typed lookup: credentials whose TYPE is the provider id
    const infos = await store.list()
    const matches = infos.filter(i => i.type === providerId)
    if (matches.length === 1) {
      const { data } = await store.getByName(matches[0]!.name)
      return toResolved(data)
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple "${providerId}" credentials exist (${matches.map(m => `"${m.name}"`).join(', ')}) — ` +
        `pass credentialName to choose one`
      )
    }

    // Deprecated magic-name fallback
    const legacyName = BUILTIN_CREDENTIAL_NAMES[providerId as BuiltinProviderId]
    if (legacyName) {
      try {
        const { data } = await store.getByName(legacyName)
        return toResolved(data)
      } catch { /* fall through to guidance */ }
    }

    throw new Error(
      `No "${providerId}" credential found. Add one on the dashboard Credentials page ` +
      `(type "${providerId}"), or import from env via importLlmKeysFromEnv().`
    )
  }
}

/** Pull the JSON object out of a model reply that may carry fences or prose. */
export function extractJson(text: string): string {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  return start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Imports LLM API keys found in environment variables into the CredentialStore
 * as TYPED credentials (type 'anthropic', data { apiKey }, …). Idempotent: a
 * provider that already has a typed credential is skipped.
 *
 * Mapping: ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / …
 */
export async function importLlmKeysFromEnv(
  credentialStore: CredentialStore,
): Promise<string[]> {
  const imported: string[] = []
  const existing = await credentialStore.list()

  for (const provider of ['anthropic', 'openai', 'google'] as const) {
    const apiKey = process.env[`${provider.toUpperCase()}_API_KEY`]
    if (!apiKey) continue
    if (existing.some(c => c.type === provider)) continue
    await credentialStore.set(`${provider} (env)`, provider, { apiKey })
    imported.push(provider)
  }
  return imported
}
