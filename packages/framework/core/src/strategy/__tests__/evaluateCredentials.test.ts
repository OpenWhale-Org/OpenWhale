import { describe, it, expect } from 'vitest'
import { EvaluationClient, EVALUATION_CREDENTIAL_TYPE } from '../evaluate.js'
import { llmCredentialTypes } from '../../credentials/llmCredentialTypes.js'
import type { CredentialStore } from '../../types/credential.js'

/**
 * Credential resolution for the evaluation model. The call itself needs the
 * venue; what is testable here is the part that goes wrong in the dashboard:
 * no key, two keys, or a key stored without its field.
 */

function storeOf(entries: Array<{ name: string; type: string; apiKey?: string }>): CredentialStore {
  return {
    async list() {
      return entries.map((e, i) => ({
        id: String(i), name: e.name, type: e.type, createdAt: '', updatedAt: '',
      })) as Awaited<ReturnType<CredentialStore['list']>>
    },
    async getByName(name: string) {
      const found = entries.find(e => e.name === name)
      if (!found) throw new Error(`Credential "${name}" not found`)
      return { type: found.type, data: found.apiKey === undefined ? {} : { apiKey: found.apiKey } }
    },
    async set() { throw new Error('not used') },
    async delete() { throw new Error('not used') },
  } as unknown as CredentialStore
}

const question = { questions: { ok: { type: 'noul' as const, instructions: 'x' } }, state: 'x' }

describe('evaluation credentials', () => {
  it('says what to do when nothing is stored', async () => {
    await expect(new EvaluationClient().judge(question, storeOf([])))
      .rejects.toThrow(/No "typesafe-ai" credential stored/)
  })

  it('names the candidates when several are stored', async () => {
    const store = storeOf([
      { name: 'jev-prod', type: EVALUATION_CREDENTIAL_TYPE, apiKey: 'a' },
      { name: 'jev-test', type: EVALUATION_CREDENTIAL_TYPE, apiKey: 'b' },
    ])
    await expect(new EvaluationClient().judge(question, store))
      .rejects.toThrow(/"jev-prod", "jev-test"/)
  })

  it('refuses a credential saved without its key rather than calling with undefined', async () => {
    const store = storeOf([{ name: 'jev', type: EVALUATION_CREDENTIAL_TYPE }])
    await expect(new EvaluationClient().judge(question, store))
      .rejects.toThrow(/has no apiKey/)
  })

  it('is offered on the Credentials page as an AI provider', () => {
    const def = llmCredentialTypes.find(c => c.type === EVALUATION_CREDENTIAL_TYPE)
    expect(def).toBeDefined()
    expect(def!.category).toBe('AI Provider')
    expect(def!.test).toBeTypeOf('function')
    // The form must ask for exactly the field the client reads.
    expect(Object.keys((def!.schema as { shape: Record<string, unknown> }).shape)).toEqual(['apiKey'])
  })
})
