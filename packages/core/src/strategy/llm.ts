import { generateText, generateObject } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { ModelMessage, LanguageModel } from 'ai'
import type { ZodType } from 'zod'
import type { BuiltinProviderId, LlmOptions, ProviderConfig, BuiltinProviderConfig } from '../types/strategy.js'
import type { RetryOptions } from '../types/executor.js'
import type { CredentialStore } from '../types/credential.js'

export type { ModelMessage as CoreMessage }

/** Default credential name for each built-in provider. */
const BUILTIN_CREDENTIAL_NAMES: Record<BuiltinProviderId, string> = {
  openai:    'openai-api-key',
  anthropic: 'anthropic-api-key',
  google:    'google-api-key',
  mistral:   'mistral-api-key',
  cohere:    'cohere-api-key',
  groq:      'groq-api-key',
  xai:       'xai-api-key',
}

/** Factory functions for built-in providers. Each returns a function (modelId) => LanguageModel. */
const BUILTIN_FACTORIES: Record<BuiltinProviderId, (apiKey: string) => (modelId: string) => LanguageModel> = {
  openai:    (apiKey) => (modelId) => createOpenAI({ apiKey })(modelId),
  anthropic: (apiKey) => (modelId) => createAnthropic({ apiKey })(modelId),
  google:    (apiKey) => (modelId) => createGoogleGenerativeAI({ apiKey })(modelId),
  mistral:   (_apiKey) => (_modelId) => { throw new Error('mistral provider requires @ai-sdk/mistral — add it to your dependencies') },
  cohere:    (_apiKey) => (_modelId) => { throw new Error('cohere provider requires @ai-sdk/cohere — add it to your dependencies') },
  groq:      (_apiKey) => (_modelId) => { throw new Error('groq provider requires @ai-sdk/groq — add it to your dependencies') },
  xai:       (_apiKey) => (_modelId) => { throw new Error('xai provider requires @ai-sdk/xai — add it to your dependencies') },
}

export interface LlmCallOptions<TSchema extends ZodType | undefined = undefined> {
  messages: ModelMessage[]
  /** Override the strategy's defaultModel. Format: `'provider:model'`. */
  model?: string
  schema?: TSchema
  retry?: Partial<RetryOptions>
}

type LlmResult<TSchema extends ZodType | undefined> =
  TSchema extends ZodType ? import('zod').infer<TSchema> : string

/**
 * Manages provider instances for a single strategy.
 * Lazily initializes providers on first use and caches them.
 */
export class LlmClient {
  private readonly options: LlmOptions
  private readonly providerCache = new Map<string, (modelId: string) => LanguageModel>()

  constructor(options: LlmOptions) {
    this.options = options
  }

  async call<TSchema extends ZodType | undefined = undefined>(
    callOptions: LlmCallOptions<TSchema>,
    credentialStore: CredentialStore,
  ): Promise<LlmResult<TSchema>> {
    const modelString = callOptions.model ?? this.options.defaultModel
    if (!modelString) {
      throw new Error('No model specified. Set defaultModel in StrategyOptions.llm or pass model in the llm() call.')
    }

    const model = await this.resolveModel(modelString, credentialStore)
    const retry = callOptions.retry
    const maxRetries = retry?.maxRetries ?? 0
    const retryDelay = retry?.retryDelay ?? 500
    const maxRetryDelay = retry?.maxRetryDelay ?? 30000

    return this.callWithRetry(model, callOptions, maxRetries, retryDelay, maxRetryDelay)
  }

  private async callWithRetry<TSchema extends ZodType | undefined>(
    model: LanguageModel,
    callOptions: LlmCallOptions<TSchema>,
    maxRetries: number,
    retryDelay: number,
    maxRetryDelay: number,
  ): Promise<LlmResult<TSchema>> {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.callOnce(model, callOptions)
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
    callOptions: LlmCallOptions<TSchema>,
  ): Promise<LlmResult<TSchema>> {
    if (callOptions.schema) {
      const { object } = await generateObject({
        model,
        messages: callOptions.messages,
        schema: callOptions.schema,
      })
      return object as LlmResult<TSchema>
    }

    const { text } = await generateText({
      model,
      messages: callOptions.messages,
    })
    return text as LlmResult<TSchema>
  }

  private async resolveModel(
    modelString: string,
    credentialStore: CredentialStore,
  ): Promise<LanguageModel> {
    const colonIdx = modelString.indexOf(':')
    if (colonIdx === -1) {
      throw new Error(`Invalid model format: '${modelString}'. Expected 'provider:model', e.g. 'openai:gpt-4o'.`)
    }
    const providerId = modelString.slice(0, colonIdx)
    const modelId = modelString.slice(colonIdx + 1)

    const providerFactory = await this.getProviderFactory(providerId, credentialStore)
    return providerFactory(modelId)
  }

  private async getProviderFactory(
    providerId: string,
    credentialStore: CredentialStore,
  ): Promise<(modelId: string) => LanguageModel> {
    if (this.providerCache.has(providerId)) {
      return this.providerCache.get(providerId)!
    }

    const factory = await this.buildProviderFactory(providerId, credentialStore)
    this.providerCache.set(providerId, factory)
    return factory
  }

  private async buildProviderFactory(
    providerId: string,
    credentialStore: CredentialStore,
  ): Promise<(modelId: string) => LanguageModel> {
    // Check for explicit provider config first
    const explicitConfig = this.options.providers?.find((p): p is ProviderConfig =>
      p.provider === 'custom' ? (p as { id: string }).id === providerId : p.provider === providerId
    )

    if (explicitConfig?.provider === 'custom') {
      const { data } = await credentialStore.getByName(explicitConfig.credentialName)
      const apiKey = data['apiKey'] as string
      return explicitConfig.create(apiKey)
    }

    // Built-in provider
    const builtinId = providerId as BuiltinProviderId
    if (!(builtinId in BUILTIN_FACTORIES)) {
      throw new Error(`Unknown provider: '${providerId}'. Use a built-in provider or register a custom one via StrategyOptions.llm.providers.`)
    }

    const credentialName = (explicitConfig as BuiltinProviderConfig | undefined)?.credentialName
      ?? BUILTIN_CREDENTIAL_NAMES[builtinId]

    const { data } = await credentialStore.getByName(credentialName)
    const apiKey = data['apiKey'] as string
    return BUILTIN_FACTORIES[builtinId](apiKey)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
