import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk'
import type { Questions, SystemOneResult, TypeSafeClientConfig } from '@typesafe-ai/sdk'
import type { CredentialStore } from '../types/credential.js'

export { choice, noul, score }
export type { Questions }

/**
 * Judgment, as distinct from generation.
 *
 * `llm()` asks a language model for text (or for JSON shaped by a schema) and
 * waits for it to be written a token at a time. An EVALUATION model answers
 * questions instead: hand it a state and a map of named questions, and every
 * one is answered in parallel with a probability attached. Nothing is
 * generated, so the answer arrives in a fraction of a chat model's time and
 * the output is already a number the code can act on.
 *
 * That is why it sits beside LlmClient rather than inside it: the two have
 * different shapes, and pretending a probability is a sentence would lose the
 * part that makes it useful.
 *
 * TypeSafe's Jev is the model behind it today. The client is its own SDK
 * rather than the AI SDK's provider: `@ai-sdk/typesafe-ai` needs AI SDK v7's
 * `experimental_evaluate`, and the framework is on v6 — moving the whole
 * LLM surface a major version to reach one model is a separate decision.
 * Swapping to the provider later means rewriting this file and nothing else.
 */

export const EVALUATION_CREDENTIAL_TYPE = 'typesafe-ai'
export const DEFAULT_EVALUATION_MODEL = 'jev-latest'

export interface JudgeOptions<Q extends Questions> {
  /** What the questions are about: text, or a JSON object the questions can path into. */
  state: unknown
  /** Named questions, built with `choice()` / `score()` / `noul()`. */
  questions: Q
  /** Model id. Default `jev-latest`; pin a version to keep thresholds meaningful. */
  model?: string
  /** Pin a credential by name — needed only when several TypeSafe keys are stored. */
  credentialName?: string
  /** Per-attempt timeout, ms. Default 10_000 (the SDK's). */
  timeoutMs?: number
}

export type JudgeResult<Q extends Questions> = SystemOneResult<Q>

/**
 * Evaluation access for one consumer, mirroring LlmClient's credential rules:
 * an explicit name wins, otherwise the single stored credential of the type,
 * otherwise an error that says what to do.
 */
export class EvaluationClient {
  async judge<const Q extends Questions>(
    options: JudgeOptions<Q>,
    credentialStore: CredentialStore,
  ): Promise<JudgeResult<Q>> {
    const apiKey = await resolveKey(credentialStore, options.credentialName)
    const config: TypeSafeClientConfig = {
      apiKey,
      defaultModel: options.model ?? DEFAULT_EVALUATION_MODEL,
      ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
    }
    const client = new TypeSafeClient(config)
    return client.systemOne({
      state: options.state as never,
      questions: options.questions,
      ...(options.model !== undefined ? { model: options.model } : {}),
    })
  }
}

async function resolveKey(store: CredentialStore, credentialName?: string): Promise<string> {
  const keyOf = (name: string, data: Record<string, unknown>): string => {
    const key = data['apiKey']
    if (typeof key !== 'string' || key === '') throw new Error(`Credential "${name}" has no apiKey`)
    return key
  }
  if (credentialName) {
    const { data } = await store.getByName(credentialName)
    return keyOf(credentialName, data)
  }
  const matches = (await store.list()).filter(i => i.type === EVALUATION_CREDENTIAL_TYPE)
  if (matches.length === 1) {
    const name = matches[0]!.name
    const { data } = await store.getByName(name)
    return keyOf(name, data)
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple "${EVALUATION_CREDENTIAL_TYPE}" credentials exist ` +
      `(${matches.map(m => `"${m.name}"`).join(', ')}) — pass credentialName to choose one`,
    )
  }
  throw new Error(
    `No "${EVALUATION_CREDENTIAL_TYPE}" credential stored. Add one on the Credentials page (TypeSafe / Jev), ` +
    'or pass credentialName.',
  )
}
