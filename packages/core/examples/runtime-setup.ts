/**
 * Example: Full runtime setup
 *
 * Shows how to register Monitor, Executor, and Strategy with OpenWhaleRuntime,
 * then activate a StrategyInstance to get the whole system running.
 *
 * How to run (build first):
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
  // ── 1. Initialize database + CredentialStore ─────────────────────────────
  // Encryption key from env; use KMS or Vault in production
  const encryptionKey = process.env['OPENWHALE_ENCRYPTION_KEY']
  if (!encryptionKey) throw new Error('OPENWHALE_ENCRYPTION_KEY is required')

  const dbPath = path.join(homedir(), '.openwhale', 'openwhale.db')
  const database = new SQLiteAdapter({ filePath: dbPath })
  await database.initialize()

  const credentials = new DBCredentialStore(encryptionKey, database)

  // Store API key on first run (comment out afterwards):
  // await credentials.set('openai-api-key', 'api-key', { value: process.env['OPENAI_API_KEY'] ?? '' })

  // ── 2. Create Runtime ─────────────────────────────────────────────────────
  const runtime = new OpenWhaleRuntime({ credentialStore: credentials, database })

  const now = new Date().toISOString()

  // ── 3. Register Monitor ───────────────────────────────────────────────────
  runtime.registerMonitor(
    {
      id: 'price',
      name: 'Price Monitor',
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    new PriceMonitor(5000),  // poll every 5 seconds
  )

  // ── 4. Register Executor ──────────────────────────────────────────────────
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

  // ── 5. Register Strategy ──────────────────────────────────────────────────
  // registerStrategy takes a factory function; a new instance is created per activate()
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

  // ── 6. Activate StrategyInstances ────────────────────────────────────────
  // triggers are generated dynamically by strategy.triggers(params); not declared on the instance

  // Instance A: trigger MomentumStrategy on BTC price changes
  await runtime.activate({
    id: 'instance-momentum-btc',
    name: 'BTC Momentum',
    strategyId: 'momentum',
    accounts: [],  // MomentumStrategy does not require accounts
    params: {
      base:    { symbol: 'BTC' },
      tunable: {},  // use defaults from tunableParamsSchema
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })

  // Instance B: trigger AiTradingStrategy every minute (watching BTC + ETH)
  await runtime.activate({
    id: 'instance-ai-trading',
    name: 'AI Trading (1m)',
    strategyId: 'ai-trading',
    accounts: [],  // fill with credential names if account operations are needed, e.g. ['my-exchange']
    params: {
      base:    { watchlist: ['BTC', 'ETH'] },
      tunable: {},
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })

  // ── 7. Start ──────────────────────────────────────────────────────────────
  await runtime.start()
  console.log('OpenWhale runtime started. Press Ctrl+C to stop.')

  // graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    await runtime.stop()
    process.exit(0)
  })
}

main().catch(console.error)
