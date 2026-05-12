/**
 * Runnable example — MomentumStrategy 始终运行；
 * 若环境变量中存在 LLM API Key，则同时激活 AiTradingStrategy。
 *
 * 支持的环境变量（自动扫描，取第一个匹配的 provider）：
 *   OPENAI_API_KEY      → openai:gpt-4o-mini
 *   ANTHROPIC_API_KEY   → anthropic:claude-haiku-4-5-20251001
 *   GOOGLE_API_KEY      → google:gemini-1.5-flash
 *
 * 运行方式：
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

// 每个 provider 对应的默认 model
const DEFAULT_MODELS: Partial<Record<BuiltinProviderId, string>> = {
  openai:    'openai:gpt-4o-mini',
  anthropic: 'anthropic:claude-haiku-4-5-20251001',
  google:    'google:gemini-1.5-flash',
}

async function main() {
  // ── 临时数据库（退出时自动清理）────────────────────────────────────────────
  const dbPath = path.join(os.tmpdir(), `openwhale-example-${Date.now()}.db`)
  const database = new SQLiteAdapter({ filePath: dbPath })
  await database.initialize()

  const credentials = new DBCredentialStore('example-key', database)

  // ── 扫描环境变量，将 LLM API Key 导入 CredentialStore ─────────────────────
  const importedProviders = await importLlmKeysFromEnv(credentials)
  const activeProvider = importedProviders[0]
  const defaultModel = activeProvider ? DEFAULT_MODELS[activeProvider] : undefined

  // ── Runtime ───────────────────────────────────────────────────────────────
  const runtime = new OpenWhaleRuntime({ database, credentialStore: credentials })
  const now = new Date().toISOString()

  // ── 注册 Monitor ──────────────────────────────────────────────────────────
  runtime.registerMonitor(
    { id: 'price', name: 'Price Monitor', source: 'builtin', createdAt: now, updatedAt: now },
    new PriceMonitor(2000),
  )

  // ── 注册 Executor ─────────────────────────────────────────────────────────
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

  // ── 注册 Strategy ─────────────────────────────────────────────────────────
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

  // ── 激活实例 ──────────────────────────────────────────────────────────────
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
    console.log(`LLM 已检测到 (${defaultModel}) — AiTradingStrategy 已激活。\n`)
  } else {
    console.log('未检测到 LLM API Key，仅运行 MomentumStrategy。')
    console.log('设置 OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY 可同时激活 AiTradingStrategy。\n')
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────
  await runtime.start()
  console.log('Runtime 已启动，运行 30 秒后自动退出...\n')

  await new Promise<void>(resolve => setTimeout(resolve, 30_000))

  console.log('\n正在关闭...')
  await runtime.stop()
  await database.close()
  fs.rmSync(dbPath, { force: true })
  console.log('完成。')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
