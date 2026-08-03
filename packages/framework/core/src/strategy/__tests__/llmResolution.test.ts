import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { LlmClient } from '../llm.js'
import { BaseStrategy } from '../BaseStrategy.js'
import { Strategy, Llm } from '../decorators.js'
import { OpenWhaleRuntime } from '../../runtime/OpenWhaleRuntime.js'
import type { CredentialStore, CredentialInfo, CredentialData, RawCredentialData } from '../../types/credential.js'
import type { ExecutionInstruction } from '../../types/executor.js'
import type { StrategyDeclarations } from '../BaseStrategy.js'
import fs from 'fs'
import os from 'os'
import path from 'path'

function memoryStore(entries: Array<{ name: string; type: string; data: RawCredentialData }>): CredentialStore {
  const now = new Date().toISOString()
  return {
    async set(name, type, data) {
      entries.push({ name, type, data })
      return { id: name, name, type, createdAt: now, updatedAt: now }
    },
    async getByName(name): Promise<CredentialData> {
      const found = entries.find(e => e.name === name)
      if (!found) throw new Error(`Credential "${name}" not found`)
      return { type: found.type, data: found.data }
    },
    async delete() {},
    async list(): Promise<CredentialInfo[]> {
      return entries.map(e => ({ id: e.name, name: e.name, type: e.type, createdAt: now, updatedAt: now }))
    },
  } as CredentialStore
}

describe('LlmClient credential resolution', () => {
  const client = new LlmClient()

  it('uses the single typed credential of the provider', async () => {
    const store = memoryStore([{ name: 'My Anthropic', type: 'anthropic', data: { apiKey: 'sk-1' } }])
    const model = await client.resolveModel('anthropic:claude-sonnet-5', store)
    expect(model).toBeTruthy()
  })

  it('errors listing names when several typed credentials exist', async () => {
    const store = memoryStore([
      { name: 'personal', type: 'anthropic', data: { apiKey: 'a' } },
      { name: 'company', type: 'anthropic', data: { apiKey: 'b' } },
    ])
    await expect(client.resolveModel('anthropic:claude-sonnet-5', store))
      .rejects.toThrow(/"personal", "company".*credentialName/s)
  })

  it('explicit credentialName disambiguates', async () => {
    const store = memoryStore([
      { name: 'personal', type: 'anthropic', data: { apiKey: 'a' } },
      { name: 'company', type: 'anthropic', data: { apiKey: 'b' } },
    ])
    await expect(client.resolveModel('anthropic:claude-sonnet-5', store, 'company')).resolves.toBeTruthy()
  })

  it('falls back to the legacy magic name (data.value)', async () => {
    const store = memoryStore([{ name: 'anthropic-api-key', type: 'api-key', data: { value: 'sk-legacy' } }])
    await expect(client.resolveModel('anthropic:claude-sonnet-5', store)).resolves.toBeTruthy()
  })

  it('guides to the dashboard when nothing matches', async () => {
    const store = memoryStore([])
    await expect(client.resolveModel('anthropic:claude-sonnet-5', store))
      .rejects.toThrow(/Credentials page/)
  })

  it('openai-compatible passes baseURL through', async () => {
    const store = memoryStore([{ name: 'DeepSeek', type: 'openai-compatible', data: { apiKey: 'k', baseURL: 'https://api.deepseek.com/v1' } }])
    await expect(client.resolveModel('openai-compatible:deepseek-chat', store)).resolves.toBeTruthy()
  })

  it('anthropic-compatible passes baseURL through', async () => {
    const store = memoryStore([{ name: 'Kimi', type: 'anthropic-compatible', data: { apiKey: 'k', baseURL: 'https://api.moonshot.cn/anthropic' } }])
    await expect(client.resolveModel('anthropic-compatible:kimi-k2', store)).resolves.toBeTruthy()
  })
})

describe('builtin LLM credential types', () => {
  it('are registered by the runtime and serialized with schemas', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owllm-'))
    const runtime = new OpenWhaleRuntime({ dataDir: tmp })
    const types = runtime.describeCredentialTypes().map(t => t.type)
    for (const t of ['anthropic', 'openai', 'google', 'openai-compatible', 'anthropic-compatible']) expect(types).toContain(t)
    const anthropic = runtime.describeCredentialTypes().find(t => t.type === 'anthropic')!
    expect(anthropic.hasTest).toBe(true)
    expect(anthropic.jsonSchema).toBeTruthy()
    fs.rmSync(tmp, { recursive: true, force: true })
  })
})

describe('llms declaration', () => {
  const decls = {
    llms: [
      { label: 'analysis', model: 'anthropic:claude-haiku-4-5' },
      { label: 'decision', model: 'anthropic:claude-sonnet-5', settings: { temperature: 0 } },
    ],
  } as const satisfies StrategyDeclarations

  class AiStrategy extends BaseStrategy<typeof decls> {
    readonly strategyId = 'ai'
    override readonly llms = decls.llms
    readonly baseParamsSchema = z.object({})
    readonly tunableParamsSchema = z.object({})
    async evaluate(): Promise<ExecutionInstruction[]> { return [] }
    // expose the private merge for assertions
    slot(label: 'analysis' | 'decision', call?: { model?: string }) {
      return (this as unknown as { _llmSlotConfig(l: string, c?: unknown): { model?: string; credentialName?: string; settings: Record<string, unknown> } })._llmSlotConfig(label, call)
    }
  }

  it('merges declaration ← instance binding ← call, in that order', () => {
    const s = new AiStrategy()
    expect(s.slot('decision').model).toBe('anthropic:claude-sonnet-5')
    expect(s.slot('decision').settings).toEqual({ temperature: 0 })

    s.setLlmBindings({ decision: { model: 'openai:gpt-4o', credentialName: 'company', settings: { temperature: 0.5 } } })
    expect(s.slot('decision')).toEqual({ model: 'openai:gpt-4o', credentialName: 'company', settings: { temperature: 0.5 } })
    expect(s.slot('analysis').model).toBe('anthropic:claude-haiku-4-5')   // untouched slot keeps defaults

    expect(s.slot('decision', { model: 'google:gemini-2.0-flash' }).model).toBe('google:gemini-2.0-flash')
  })

  it('derives llmRequirements at registration', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owllm-'))
    const runtime = new OpenWhaleRuntime({ dataDir: tmp })
    const now = new Date().toISOString()
    runtime.registerStrategy(
      { id: 'ai', name: 'AI', source: 'builtin', createdAt: now, updatedAt: now },
      () => new AiStrategy(),
    )
    const def = runtime.listStrategies().find(s => s.id === 'ai')!
    expect(def.llmRequirements).toEqual([
      { label: 'analysis', model: 'anthropic:claude-haiku-4-5' },
      { label: 'decision', model: 'anthropic:claude-sonnet-5', settings: { temperature: 0 } },
    ])
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('@Llm decorator declares slots', () => {
    @Strategy('decorated-ai')
    @Llm('decision', 'anthropic:claude-sonnet-5', { settings: { temperature: 0.2 } })
    class D extends BaseStrategy {
      readonly baseParamsSchema = z.object({})
      readonly tunableParamsSchema = z.object({})
      async evaluate(): Promise<ExecutionInstruction[]> { return [] }
    }
    const d = new D()
    expect(d.llms).toEqual([{ label: 'decision', model: 'anthropic:claude-sonnet-5', settings: { temperature: 0.2 } }])
  })
})

describe('extractJson', () => {
  it('strips fences and surrounding prose', async () => {
    const { extractJson } = await import('../llm.js')
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}')
    expect(extractJson('Here is the result:\n{"a":{"b":2}}\nHope this helps!')).toBe('{"a":{"b":2}}')
    expect(extractJson('{"plain":true}')).toBe('{"plain":true}')
  })
})
