/**
 * Runnable example — MomentumStrategy always runs;
 * if an LLM API key is present in the environment, AiTradingStrategy is also activated.
 *
 * Supported environment variables (scanned in order; first match wins):
 *   OPENAI_API_KEY      → openai:gpt-4o-mini
 *   ANTHROPIC_API_KEY   → anthropic:claude-haiku-4-5-20251001
 *   GOOGLE_API_KEY      → google:gemini-1.5-flash
 *
 * How to run:
 *   pnpm example
 *   OPENAI_API_KEY=sk-... pnpm example
 */

import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { OpenWhaleRuntime } from '../src/runtime/OpenWhaleRuntime.js'
import { SQLiteAdapter } from '../src/database/SQLiteAdapter.js'
import { DBCredentialStore } from '../src/credentials/DBCredentialStore.js'
import { importLlmKeysFromEnv } from '../src/strategy/llm.js'
import { PriceMonitor } from './PriceMonitor.js'
import { TradeExecutor } from './TradeExecutor.js'
import { MomentumStrategy } from './MomentumStrategy.js'
import { AiTradingStrategy } from './AiTradingStrategy.js'
import type { BuiltinProviderId } from '../src/types/strategy.js'

// default model per provider
const DEFAULT_MODELS: Partial<Record<BuiltinProviderId, string>> = {
  openai:    'openai:gpt-4o-mini',
  anthropic: 'anthropic:claude-haiku-4-5-20251001',
  google:    'google:gemini-1.5-flash',
}

async function main() {
  // ── Temporary database (auto-cleaned on exit) ─────────────────────────────
  const dbPath = path.join(os.tmpdir(), `openwhale-example-${Date.now()}.db`)
  const database = new SQLiteAdapter({ filePath: dbPath })
  await database.initialize()

  const credentials = new DBCredentialStore('example-key', database)

  // ── Scan env vars and import LLM API keys into CredentialStore ───────────
  const importedProviders = await importLlmKeysFromEnv(credentials)
  const activeProvider = importedProviders[0]
  const defaultModel = activeProvider ? DEFAULT_MODELS[activeProvider] : undefined

  // ── Runtime ───────────────────────────────────────────────────────────────
  const runtime = new OpenWhaleRuntime({ database, credentialStore: credentials })
  const now = new Date().toISOString()

  // ── Register Monitor ──────────────────────────────────────────────────────
  runtime.registerMonitor(
    { id: 'price', name: 'Price Monitor', source: 'builtin', createdAt: now, updatedAt: now },
    new PriceMonitor(2000),
  )

  // ── Register Executor ─────────────────────────────────────────────────────
  runtime.registerExecutor(
    {
      id: 'trade',
      name: 'Trade Executor',
      source: 'builtin',
      supportedActions: ['buy', 'sell', 'cancel'],
      createdAt: now,
      updatedAt: now,
    },
    new TradeExecutor(),
  )

  // ── Register Strategy ─────────────────────────────────────────────────────
  runtime.registerStrategy(
    {
      id: 'momentum',
      name: 'Momentum Strategy',
      source: 'builtin',
      monitorIds: ['price'],
      executorIds: ['trade'],
      createdAt: now,
      updatedAt: now,
    },
    () => new MomentumStrategy(),
  )

  if (defaultModel) {
    runtime.registerStrategy(
      {
        id: 'ai-trading',
        name: 'AI Trading Strategy',
        source: 'builtin',
        monitorIds: ['price'],
        executorIds: ['trade'],
        createdAt: now,
        updatedAt: now,
      },
      () => new AiTradingStrategy({ llm: { defaultModel } }),
    )
  }

  // ── Activate instances ────────────────────────────────────────────────────
  await runtime.activate({
    id: 'instance-btc',
    name: 'BTC Momentum',
    strategyId: 'momentum',
    accounts: [],
    params: {
      base:    { symbol: 'BTC' },
      tunable: { shortWindow: 3, longWindow: 5, threshold: 1.001 },
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })

  await runtime.activate({
    id: 'instance-eth',
    name: 'ETH Momentum',
    strategyId: 'momentum',
    accounts: [],
    params: {
      base:    { symbol: 'ETH' },
      tunable: { shortWindow: 3, longWindow: 5, threshold: 1.001 },
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })

  if (defaultModel) {
    await runtime.activate({
      id: 'instance-ai-trading',
      name: 'AI Trading (1m)',
      strategyId: 'ai-trading',
      accounts: [],
      params: {
        base:    { watchlist: ['BTC', 'ETH'] },
        tunable: {},
      },
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    console.log(`LLM detected (${defaultModel}) — AiTradingStrategy activated.\n`)
  } else {
    console.log('No LLM API key found; running MomentumStrategy only.')
    console.log('Set OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY to also activate AiTradingStrategy.\n')
  }

  // ── Start ─────────────────────────────────────────────────────────────────
  await runtime.start()
  console.log('Runtime started; will auto-exit after 30 seconds...\n')

  await new Promise<void>(resolve => setTimeout(resolve, 30_000))

  console.log('\nShutting down...')
  await runtime.stop()
  await database.close()
  fs.rmSync(dbPath, { force: true })
  console.log('Done.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
