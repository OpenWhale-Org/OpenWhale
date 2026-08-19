import { z } from 'zod'
import { generateText } from 'ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { CredentialTypeDefinition } from '../types/materialization.js'
import type { RawCredentialData } from '../types/credential.js'

/**
 * Built-in LLM credential types — framework infrastructure, not domain
 * vocabulary (LlmClient lives in core, like this.http / this.store), so the
 * runtime registers these itself. They declare NO kinds: LLM keys are consumed
 * by LlmClient (compiler + strategies' llm slots), not by the materialization
 * pipeline. Should a kind ever need them, factories can be added to these
 * types later with zero migration — kinds belong to factories, not credentials.
 *
 * Data shape: { apiKey } (+ baseURL for openai-compatible). The dashboard form
 * is derived from the schema like any other credential type.
 */

const apiKeyField = z.string().min(1).meta({ displayName: 'API Key', password: true })

/** 1-token generation proves key validity end-to-end. */
function generateTest(model: Parameters<typeof generateText>[0]['model']) {
  return generateText({ model, prompt: 'ping', maxOutputTokens: 1 })
}

export const llmCredentialTypes: CredentialTypeDefinition[] = [
  {
    type: 'anthropic',
    displayName: 'Anthropic',
    category: 'AI Provider',
    logo: '/brands/claude.svg',
    icon: '🧠',
    description: 'Claude models, direct from Anthropic.',
    documentationUrl: 'https://console.anthropic.com/settings/keys',
    schema: z.object({ apiKey: apiKeyField }),
    test: async (data: RawCredentialData) => {
      await generateTest(createAnthropic({ apiKey: data['apiKey'] as string })('claude-haiku-4-5'))
    },
  },
  {
    type: 'openai',
    displayName: 'OpenAI',
    category: 'AI Provider',
    logo: '/brands/openai.svg',
    icon: '⚛️',
    description: 'GPT models, direct from OpenAI.',
    documentationUrl: 'https://platform.openai.com/api-keys',
    schema: z.object({ apiKey: apiKeyField }),
    test: async (data: RawCredentialData) => {
      await generateTest(createOpenAI({ apiKey: data['apiKey'] as string })('gpt-4o-mini'))
    },
  },
  {
    type: 'google',
    displayName: 'Google (Gemini)',
    category: 'AI Provider',
    logo: '/brands/gemini.svg',
    icon: '♊',
    description: 'Gemini models via Google AI Studio.',
    documentationUrl: 'https://aistudio.google.com/apikey',
    schema: z.object({ apiKey: apiKeyField }),
    test: async (data: RawCredentialData) => {
      await generateTest(createGoogleGenerativeAI({ apiKey: data['apiKey'] as string })('gemini-2.0-flash'))
    },
  },
  {
    type: 'anthropic-compatible',
    displayName: 'Anthropic-compatible (Kimi / GLM / proxy…)',
    category: 'AI Provider',
    logo: '/brands/glm.png',
    icon: '🧩',
    description: 'Any endpoint that speaks the Anthropic protocol — Kimi, GLM, a proxy.',
    schema: z.object({
      apiKey: apiKeyField,
      baseURL: z.string().url().meta({ displayName: 'Base URL', placeholder: 'https://api.moonshot.cn/anthropic', description: 'Anthropic-protocol endpoint root' }),
    }),
    test: async (data: RawCredentialData) => {
      const res = await fetch(`${String(data['baseURL']).replace(/\/$/, '')}/v1/models`, {
        headers: { 'x-api-key': data['apiKey'] as string, 'anthropic-version': '2023-06-01' },
      })
      if (!res.ok) throw new Error(`GET /v1/models failed: HTTP ${res.status}`)
    },
  },
  {
    type: 'openai-compatible',
    displayName: 'OpenAI-compatible (DeepSeek / Ollama / proxy…)',
    category: 'AI Provider',
    logo: '/brands/deepseek.svg',
    icon: '🔌',
    description: 'Any endpoint that speaks the OpenAI protocol — DeepSeek, Ollama, a proxy.',
    schema: z.object({
      apiKey: apiKeyField,
      baseURL: z.string().url().meta({ displayName: 'Base URL', placeholder: 'https://api.deepseek.com/v1', description: 'OpenAI-compatible endpoint root' }),
    }),
    test: async (data: RawCredentialData) => {
      // Endpoint discovery instead of a paid generation — we cannot know a valid model id.
      const res = await fetch(`${String(data['baseURL']).replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${data['apiKey'] as string}` },
      })
      if (!res.ok) throw new Error(`GET /models failed: HTTP ${res.status}`)
    },
  },
]
