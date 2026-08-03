/**
 * Runnable end-to-end example: copy trading, assembled in code
 *
 * Shows how to assemble a runtime WITHOUT the dashboard — plugins, credentials,
 *   1. Initialize HyperliquidAdapter (read-only, for the monitor)
 *   2. Register UserTradesMonitor (watch target address fills)
 *   3. Register PerpTradingExecutor (executes orders using the account's adapter)
 *   4. Register AccountFactory (framework creates the account from stored credentials)
 *   5. Activate an examples/copy-trading instance
 *
 * The executor's private key comes from the credential stored in CredentialStore,
 * not from an environment variable. Only the monitor needs a read-only wallet address.
 *
 * ── Required environment variables ───────────────────────────────────────────
 *
 *   OPENWHALE_ENCRYPTION_KEY   required  database encryption key (any non-empty string; 32-byte hex recommended)
 *                                        generate: openssl rand -hex 32
 *
 *   HL_WALLET_ADDRESS          required  your Hyperliquid wallet address (0x...)
 *
 *   HL_PRIVATE_KEY             required  corresponding private key (0x...) — stored in CredentialStore,
 *                                        never passed directly to the executor
 *                                        ⚠️  do not commit to version control; store in a .env file
 *
 *   HL_TARGET_ADDRESS          required  address to copy trades from
 *
 * ── Optional environment variables ───────────────────────────────────────────
 *
 *   OPENWHALE_DATA_DIR         optional  data directory; defaults to ~/.openwhale
 *   MOCK_EXECUTOR              optional  set to 'true' to log instructions without placing real orders
 *                                        (mock mode also works without HL_PRIVATE_KEY)
 *   HL_TESTNET                 optional  set to 'true' to trade on the Hyperliquid testnet
 *
 * ── How to run ────────────────────────────────────────────────────────────────
 *
 *   Put the variables in packages/strategies/examples/runnable/.env (gitignored), then:
 *
 *     pnpm engine                # from the repo root, or:
 *     pnpm --filter @openwhaleorg/examples run:copy-trading
 *
 *   Or export them manually and run directly:
 *
 *     export OPENWHALE_ENCRYPTION_KEY="$(openssl rand -hex 32)"
 *     export HL_WALLET_ADDRESS="0xYourWalletAddress"
 *     export HL_PRIVATE_KEY="0xYourPrivateKey"
 *     export HL_TARGET_ADDRESS="0xTargetAddress"
 *     npx tsx packages/strategies/examples/runnable/copy-trading.ts
 */

import { OpenWhaleRuntime, DBCredentialStore, SQLiteAdapter, BaseExecutor, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, ExecutionResult, ExecutorCredentialSlot } from '@openwhaleorg/core'
import { exchangePlugin } from '@openwhaleorg/exchange'
import { hyperliquidPlugin } from '@openwhaleorg/hyperliquid'
import { examplesPlugin } from '../src/plugin.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TARGET_ADDRESS = process.env['HL_TARGET_ADDRESS'] ?? ''

const mockLog = createLogger('MockExecutor')
const log = createLogger('CopyTradingExample')

// Mock executor for dry-run mode — declares the same credential slot as the
// real 'exchange/perp-trading' so materialization passes, but never trades.
class MockExecutor extends BaseExecutor<ExecutionInstruction> {
  constructor() { super() }
  get executorName() { return 'perp-trading' }
  get supportedActions() { return ['placeOrder', 'cancelOrder', 'setLeverage'] }
  override get credentials(): readonly ExecutorCredentialSlot[] {
    return [{ label: 'trading', kind: 'exchange/perp' }]
  }

  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult<ExecutionInstruction>> {
    mockLog.info({ action: instruction.action, params: instruction.params, messageId: instruction.messageId }, '[MOCK] Would execute instruction')
    return { instruction, status: 'success', executedAt: new Date() }
  }
}

async function main() {
  // ── 1. Read environment variables ────────────────────────────────────────
  const encryptionKey = process.env['OPENWHALE_ENCRYPTION_KEY']
  const walletAddress = process.env['HL_WALLET_ADDRESS']
  const privateKey    = process.env['HL_PRIVATE_KEY']
  const testnet       = process.env['HL_TESTNET'] === 'true'
  const isMock        = process.env['MOCK_EXECUTOR'] === 'true'

  if (!encryptionKey) throw new Error('OPENWHALE_ENCRYPTION_KEY is required')
  if (!walletAddress) throw new Error('HL_WALLET_ADDRESS is required')
  // Mock mode never signs orders, so it works without a private key
  if (!privateKey && !isMock) throw new Error('HL_PRIVATE_KEY is required (or set MOCK_EXECUTOR=true for a dry run)')
  if (!TARGET_ADDRESS) throw new Error('HL_TARGET_ADDRESS is required')

  // ── 2. Initialize database + CredentialStore ─────────────────────────────
  const dataDir  = process.env['OPENWHALE_DATA_DIR'] ?? join(homedir(), '.openwhale')
  const dbPath   = join(dataDir, 'openwhale.db')
  const database = new SQLiteAdapter({ filePath: dbPath })
  await database.initialize()

  const credentialStore = new DBCredentialStore(encryptionKey, database)

  // Store Hyperliquid credentials (written on first run; overwritten on subsequent runs).
  // The credential name 'HL Main' must match the name in StrategyInstance.accounts.
  await credentialStore.set('HL Main', 'hyperliquid', {
    walletAddress,
    ...(privateKey ? { privateKey } : {}),
    testnet,
  })

  // ── 3. Assemble Runtime via plugins ───────────────────────────────────────
  const runtime = new OpenWhaleRuntime({ database, credentialStore, dataDir })
  runtime.loadPlugin(exchangePlugin, {})            // kind 'exchange/perp' + shared executor
  runtime.loadPlugin(hyperliquidPlugin, {})          // credential type + the fills monitor (testnet rides on the credential)
  runtime.loadPlugin(examplesPlugin, {})             // the reference strategies, copy-trading among them

  const now = new Date().toISOString()

  // MOCK_EXECUTOR=true: overwrite the shared executor registration with a
  // logger that never trades — same credential slot, zero real orders.
  log.info({ mock: isMock }, 'Executor mode')
  if (isMock) {
    runtime.registerExecutor(
      { id: 'exchange/perp-trading', name: 'Mock Perp Trading Executor', source: 'builtin', supportedActions: ['placeOrder', 'cancelOrder', 'setLeverage'], createdAt: now, updatedAt: now },
      new MockExecutor(),
    )
  }

  // ── 5. Start Runtime ──────────────────────────────────────────────────────
  await runtime.start()

  // ── 6. Activate copy-trading strategy instance ────────────────────────────
  await runtime.activate({
    id: 'copy-trading-instance-1',
    name: `Copy ${TARGET_ADDRESS.slice(0, 8)}...`,
    strategyId: 'examples/copy-trading',
    accounts: ['HL Main'],   // credential name — framework resolves it to an account at activate()
    params: {
      base: {
        targetAddress: TARGET_ADDRESS,
        ratio: 0.5,
        maxPositionUsd: 1000,
      },
      tunable: {
        minTradeUsd: 10,
        slippage: 0.005,
      },
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })

  console.log(`CopyTrading started — tracking ${TARGET_ADDRESS}`)
  console.log('Press Ctrl+C to stop')

  // ── 7. Graceful shutdown ──────────────────────────────────────────────────
  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    await runtime.stop()   // also closes accounts and the database
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
