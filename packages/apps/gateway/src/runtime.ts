/**
 * OpenWhale Runtime singleton — the gateway process owns exactly one.
 */
import { OpenWhaleRuntime, SQLiteAdapter, DBCredentialStore, getLogger, importLlmKeysFromEnv } from '@openwhaleorg/core'
import { exchangePlugin } from '@openwhaleorg/exchange'
import { web3Plugin } from '@openwhaleorg/web3'
import { hyperliquidPlugin } from '@openwhaleorg/hyperliquid'
import { examplesPlugin } from '@openwhaleorg/examples'
import { binancePlugin } from '@openwhaleorg/binance'
import { asterPlugin } from '@openwhaleorg/aster'
import { allVenuePlugins } from '@openwhaleorg/venues'
import path from 'path'
import os from 'os'
import { restorePlugins } from './plugins.js'
import { notifyCredentialTypes } from './notify/credentialTypes.js'
import { AlertService, setAlertService } from './notify/alerts.js'
import { RetentionService, setRetentionService } from './maintenance/retention.js'

let runtimeSingleton: OpenWhaleRuntime | undefined
/** The same SQLite file backs auth — one database, one lifecycle. */
let databaseSingleton: SQLiteAdapter | undefined
let credentialStoreSingleton: DBCredentialStore | undefined
let startPromise: Promise<void> | undefined

function createRuntime(): OpenWhaleRuntime {
  // Set log level — getLogger() returns the pino root instance, level can be changed at runtime
  getLogger().level = process.env['LOG_LEVEL'] ?? 'debug'

  const dbPath =
    process.env['OPENWHALE_DB_PATH'] ||
    path.join(os.homedir(), '.openwhale', 'openwhale.db')

  const masterKey = process.env['OPENWHALE_MASTER_KEY']
  if (!masterKey) {
    // Credentials hold real exchange private keys — never encrypt them with a
    // well-known default. Fail closed instead.
    throw new Error(
      'OPENWHALE_MASTER_KEY is not set. Set it to a strong secret before starting the dashboard; ' +
      'it encrypts stored credentials (exchange private keys) at rest. ' +
      'Migration note: credentials saved by older versions were encrypted under the removed default ' +
      '"dev-master-key" — to recover them, start once with OPENWHALE_MASTER_KEY=dev-master-key, ' +
      're-enter your credentials, then switch to a strong key.'
    )
  }

  const database = new SQLiteAdapter({ filePath: dbPath })
  databaseSingleton = database
  const credentialStore = new DBCredentialStore(masterKey, database)

  const runtime = new OpenWhaleRuntime({ database, credentialStore })
  credentialStoreSingleton = credentialStore

  // Alerting keys are registered by the gateway, not by a plugin: how an
  // operator is reached is a property of the deployment, and putting a mail
  // library behind a framework package would charge every plugin for it.
  for (const type of notifyCredentialTypes) runtime.registerCredentialType(type, 'core')

  // The exchange domain plugin must load first: it registers kind
  // 'exchange/perp' and the shared executor the venue plugins build on.
  runtime.loadPlugin(exchangePlugin, {})
  runtime.loadPlugin(web3Plugin, {})
  // testnet is a per-credential field, not a deployment flag — see the venue
  // plugins' (deliberately empty) config interfaces.
  runtime.loadPlugin(hyperliquidPlugin, {})
  runtime.loadPlugin(binancePlugin, {})
  runtime.loadPlugin(asterPlugin, {})
  // Plain ccxt venues (Bybit, OKX, Bitget, Gate, Kraken, Upbit, Lighter, …):
  // key + adapter cells only, so the roster loads as data — see @openwhaleorg/venues
  for (const venue of allVenuePlugins) runtime.loadPlugin(venue, {})
  // Reference strategies — venue-agnostic, bind any perp account at activation.
  // Loaded last: they reference monitors/executors the plugins above register.
  runtime.loadPlugin(examplesPlugin, {})

  return runtime
}

/** The credential store the runtime was built with — alerting reads keys through it. */
export function getCredentialStore(): DBCredentialStore {
  if (!credentialStoreSingleton) getRuntime()
  return credentialStoreSingleton!
}

/** The gateway's database — created with the runtime, shared by the auth store. */
export function getDatabase(): SQLiteAdapter {
  if (!databaseSingleton) getRuntime()
  return databaseSingleton!
}

export function getRuntime(): OpenWhaleRuntime {
  if (!runtimeSingleton) runtimeSingleton = createRuntime()
  return runtimeSingleton
}

export async function ensureStarted(): Promise<OpenWhaleRuntime> {
  const runtime = getRuntime()
  // Memoize the start *promise*: concurrent callers await the same boot, and a
  // failed start clears the memo so the next request retries instead of hitting
  // a permanently half-started runtime.
  if (!startPromise) {
    // Installed plugins must register BEFORE start(): start() restores persisted
    // instances, which fail to activate if their plugin strategies aren't
    // registered yet. Each manifest entry is fault-isolated inside restorePlugins.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const credentialStore = (runtime as any).credentialStore as DBCredentialStore
    startPromise = restorePlugins(runtime)
      .then(() => runtime.start())
      // AFTER start(): the database initializes inside start(), and credential
      // reads are lazy anyway. Env-provided LLM keys (ANTHROPIC_API_KEY, …)
      // become typed credentials; idempotent — skips providers that have one.
      .then(() => importLlmKeysFromEnv(credentialStore).then(() => undefined))
      // After start(), so the subscription attaches to a runtime whose
      // executors are already registered and whose database exists.
      .then(async () => {
        const alerts = new AlertService(getDatabase(), runtime, credentialStore)
        await alerts.initialize()
        setAlertService(alerts)
      })
      // Housekeeping for the monitor stores. Starts disabled in effect: the
      // table is empty until an operator saves a policy, so the hourly sweep
      // is a no-op on a fresh install.
      .then(async () => {
        const retention = new RetentionService(getDatabase(), runtime)
        await retention.initialize()
        setRetentionService(retention)
      })
      .catch((err) => {
        startPromise = undefined
        throw err
      })
  }
  await startPromise
  return runtime
}
