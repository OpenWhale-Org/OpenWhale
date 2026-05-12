/**
 * OpenWhale Runtime singleton for Next.js.
 *
 * Next.js hot-reload creates new module instances in development, so we store
 * the runtime on the global object to avoid re-initialising on every reload.
 */
import { OpenWhaleRuntime, SQLiteAdapter, DBCredentialStore } from '@openwhale/core'
import {
  HyperliquidAdapter,
  HyperliquidAccount,
  UserTradesMonitor,
  PerpTradingExecutor,
  CopyTradingStrategy,
} from '@openwhale/hyperliquid'
import path from 'path'
import os from 'os'

declare global {
  // eslint-disable-next-line no-var
  var __openwhaleRuntime: OpenWhaleRuntime | undefined
  // eslint-disable-next-line no-var
  var __openwhaleInitialized: boolean | undefined
}

function createRuntime(): OpenWhaleRuntime {
  const dbPath =
    process.env['OPENWHALE_DB_PATH'] ||
    path.join(os.homedir(), '.openwhale', 'openwhale.db')

  const masterKey = process.env['OPENWHALE_MASTER_KEY'] ?? 'dev-master-key'

  const database = new SQLiteAdapter({ filePath: dbPath })
  const credentialStore = new DBCredentialStore(masterKey, database)

  const runtime = new OpenWhaleRuntime({ database, credentialStore })

  // ── Hyperliquid plugin ────────────────────────────────────────────────────
  const now = new Date().toISOString()

  // A read-only adapter for the monitor (no private key needed for watching trades)
  const hlReadAdapter = new HyperliquidAdapter({
    walletAddress: process.env['HL_WALLET_ADDRESS'] ?? '',
  })

  runtime.registerMonitor(
    {
      id: 'hl-user-trades',
      name: 'Hyperliquid User Trades',
      description: 'Streams real-time fills for any Hyperliquid address',
      source: 'builtin',
      createdAt: now,
      updatedAt: now,
    },
    new UserTradesMonitor(hlReadAdapter),
  )

  runtime.registerExecutor(
    {
      id: 'hl-perp-trading',
      name: 'Hyperliquid Perp Trading',
      description: 'Places, cancels, and manages perpetual orders on Hyperliquid',
      source: 'builtin',
      supportedActions: ['placeOrder', 'cancelOrder', 'setLeverage'],
      createdAt: now,
      updatedAt: now,
    },
    new PerpTradingExecutor(hlReadAdapter),
  )

  runtime.registerStrategy(
    {
      id: 'hl-copy-trading',
      name: 'Hyperliquid Copy Trading',
      description: 'Mirrors another trader\'s perpetual positions at a configurable ratio',
      source: 'builtin',
      monitorIds: ['hl-user-trades'],
      executorIds: ['hl-perp-trading'],
      createdAt: now,
      updatedAt: now,
    },
    () => new CopyTradingStrategy(),
  )

  runtime.registerAccountFactory('hyperliquid', (data) =>
    new HyperliquidAccount(
      'hyperliquid',
      new HyperliquidAdapter({
        walletAddress: data['walletAddress'] as string,
        privateKey: data['privateKey'] as string,
      }),
    ),
  )

  return runtime
}

export function getRuntime(): OpenWhaleRuntime {
  if (!global.__openwhaleRuntime) {
    global.__openwhaleRuntime = createRuntime()
  }
  return global.__openwhaleRuntime
}

export async function ensureStarted(): Promise<OpenWhaleRuntime> {
  const runtime = getRuntime()
  if (!global.__openwhaleInitialized) {
    global.__openwhaleInitialized = true
    await runtime.start()
  }
  return runtime
}
