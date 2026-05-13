/**
 * OpenWhale Runtime singleton for Next.js.
 *
 * Next.js hot-reload creates new module instances in development, so we store
 * the runtime on the global object to avoid re-initialising on every reload.
 */
import { OpenWhaleRuntime, SQLiteAdapter, DBCredentialStore, getLogger } from '@openwhale/core'
import { hyperliquidPlugin } from '@openwhale/hyperliquid'
import path from 'path'
import os from 'os'

declare global {
  // eslint-disable-next-line no-var
  var __openwhaleRuntime: OpenWhaleRuntime | undefined
  // eslint-disable-next-line no-var
  var __openwhaleInitialized: boolean | undefined
}

function createRuntime(): OpenWhaleRuntime {
  // Set log level — getLogger() returns the pino root instance, level can be changed at runtime
  getLogger().level = process.env['LOG_LEVEL'] ?? 'debug'

  const dbPath =
    process.env['OPENWHALE_DB_PATH'] ||
    path.join(os.homedir(), '.openwhale', 'openwhale.db')

  const masterKey = process.env['OPENWHALE_MASTER_KEY'] ?? 'dev-master-key'

  const database = new SQLiteAdapter({ filePath: dbPath })
  const credentialStore = new DBCredentialStore(masterKey, database)

  const runtime = new OpenWhaleRuntime({ database, credentialStore })

  runtime.loadPlugin(hyperliquidPlugin, {
    walletAddress: process.env['HL_WALLET_ADDRESS'] ?? '',
    privateKey: process.env['HL_PRIVATE_KEY'],
  })

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
