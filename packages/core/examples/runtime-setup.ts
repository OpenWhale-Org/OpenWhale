/**
 * Example: 完整 Runtime 组装
 *
 * 展示如何将 Monitor、Executor、Strategy 注册到 OpenWhaleRuntime，
 * 并激活 StrategyInstance 让整个系统运转起来。
 *
 * 运行方式（需要先 build）：
 *   npx tsx packages/core/examples/runtime-setup.ts
 */

import { OpenWhaleRuntime } from '../src/runtime/OpenWhaleRuntime.js'
import { DBCredentialStore } from '../src/credentials/DBCredentialStore.js'
import { SQLiteAdapter } from '../src/database/SQLiteAdapter.js'
import * as path from 'path'
import { homedir } from 'os'
import { PriceMonitor } from './PriceMonitor.js'
import { TradeExecutor } from './TradeExecutor.js'
import { MomentumStrategy } from './MomentumStrategy.js'
import { AiTradingStrategy } from './AiTradingStrategy.js'

async function main() {
  // ── 1. 初始化数据库 + CredentialStore ────────────────────────────────────
  // 加密密钥从环境变量读取，生产环境应使用 KMS 或 Vault
  const encryptionKey = process.env['OPENWHALE_ENCRYPTION_KEY']
  if (!encryptionKey) throw new Error('OPENWHALE_ENCRYPTION_KEY is required')

  const dbPath = path.join(homedir(), '.openwhale', 'openwhale.db')
  const database = new SQLiteAdapter({ filePath: dbPath })
  await database.initialize()

  const credentials = new DBCredentialStore(encryptionKey, database)

  // 首次运行时存储 API Key（之后注释掉）：
  // await credentials.set('openai-api-key', 'api-key', { value: process.env['OPENAI_API_KEY'] ?? '' })

  // ── 2. 创建 Runtime ───────────────────────────────────────────────────────
  const runtime = new OpenWhaleRuntime({ credentialStore: credentials, database })

  const now = new Date().toISOString()

  // ── 3. 注册 Monitor ───────────────────────────────────────────────────────
  runtime.registerMonitor(
    {
      id: 'price',
      name: 'Price Monitor',
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    new PriceMonitor(5000),  // 5 秒轮询
  )

  // ── 4. 注册 Executor ──────────────────────────────────────────────────────
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

  // ── 5. 注册 Strategy ──────────────────────────────────────────────────────
  // registerStrategy 接收工厂函数，每次 activate 时创建新实例
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
    () => new AiTradingStrategy(),
  )

  // ── 6. 激活 StrategyInstance ──────────────────────────────────────────────
  // triggers 由 strategy.triggers(params) 动态生成，不在 instance 中声明

  // Instance A：BTC 价格变动时触发 MomentumStrategy
  await runtime.activate({
    id: 'instance-momentum-btc',
    name: 'BTC Momentum',
    strategyId: 'momentum',
    accounts: [],  // MomentumStrategy 不需要账户
    params: {
      base:    { symbol: 'BTC' },
      tunable: {},  // 使用 tunableParamsSchema 中的默认值
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })

  // Instance B：每分钟触发 AiTradingStrategy（监控 BTC + ETH）
  await runtime.activate({
    id: 'instance-ai-trading',
    name: 'AI Trading (1m)',
    strategyId: 'ai-trading',
    accounts: [],  // 如需账户操作，填入 credential 名称，如 ['my-exchange']
    params: {
      base:    { watchlist: ['BTC', 'ETH'] },
      tunable: {},
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })

  // ── 7. 启动 ───────────────────────────────────────────────────────────────
  await runtime.start()
  console.log('OpenWhale runtime started. Press Ctrl+C to stop.')

  // 优雅退出
  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    await runtime.stop()
    process.exit(0)
  })
}

main().catch(console.error)
