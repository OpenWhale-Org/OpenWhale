/**
 * Runnable example — no API keys required.
 *
 * Uses MomentumStrategy + PriceMonitor + TradeExecutor with an in-memory queue
 * and a temporary SQLite database. Runs for 30 seconds then exits cleanly.
 *
 * Run:
 *   npx tsx packages/core/examples/index.ts
 */

import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { OpenWhaleRuntime } from '../src/runtime/OpenWhaleRuntime.js'
import { SQLiteAdapter } from '../src/database/SQLiteAdapter.js'
import { PriceMonitor } from './PriceMonitor.js'
import { TradeExecutor } from './TradeExecutor.js'
import { MomentumStrategy } from './MomentumStrategy.js'

async function main() {
  // ── Temp DB (cleaned up on exit) ─────────────────────────────────────────
  const dbPath = path.join(os.tmpdir(), `openwhale-example-${Date.now()}.db`)
  const database = new SQLiteAdapter({ filePath: dbPath })
  await database.initialize()

  // ── Runtime ───────────────────────────────────────────────────────────────
  const runtime = new OpenWhaleRuntime({ database })
  const now = new Date().toISOString()

  // ── Register Monitor ──────────────────────────────────────────────────────
  runtime.registerMonitor(
    { id: 'price', name: 'Price Monitor', source: 'builtin', createdAt: now, updatedAt: now },
    new PriceMonitor(2000),  // poll every 2s so we see output quickly
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

  // ── Activate instances ────────────────────────────────────────────────────
  // Use a small longWindow so the strategy fires quickly with simulated data
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

  // ── Start ─────────────────────────────────────────────────────────────────
  await runtime.start()
  console.log('Runtime started. Running for 30 seconds...\n')

  // ── Stop after 30s ────────────────────────────────────────────────────────
  await new Promise<void>(resolve => setTimeout(resolve, 30_000))

  console.log('\nShutting down...')
  await runtime.stop()
  await database.close()

  // Clean up temp DB
  fs.rmSync(dbPath, { force: true })
  console.log('Done.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
