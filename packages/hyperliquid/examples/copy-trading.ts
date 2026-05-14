/**
 * Example: Hyperliquid CopyTrading
 *
 * Shows how to build a copy-trading bot using @openwhale/hyperliquid:
 *   1. Initialize HyperliquidAdapter (read-only, for the monitor)
 *   2. Register UserTradesMonitor (watch target address fills)
 *   3. Register PerpTradingExecutor (executes orders using the account's adapter)
 *   4. Register AccountFactory (framework creates HyperliquidAccount from stored credentials)
 *   5. Activate a CopyTradingStrategy instance
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
 *
 * ── How to run ────────────────────────────────────────────────────────────────
 *
 *   export OPENWHALE_ENCRYPTION_KEY="$(openssl rand -hex 32)"
 *   export HL_WALLET_ADDRESS="0xYourWalletAddress"
 *   export HL_PRIVATE_KEY="0xYourPrivateKey"
 *   export HL_TARGET_ADDRESS="0xTargetAddress"
 *   npx tsx packages/hyperliquid/examples/copy-trading.ts
 */

import { OpenWhaleRuntime, DBCredentialStore, SQLiteAdapter, BaseExecutor, createLogger } from '@openwhale/core'
import type { ExecutionInstruction, ExecutionResult } from '@openwhale/core'
import { HyperliquidAdapter } from '../src/adapter.js'
import { HyperliquidAccount } from '../src/account.js'
import { UserTradesMonitor } from '../src/monitor.js'
import { PerpTradingExecutor } from '../src/executor.js'
import { CopyTradingStrategy } from '../src/strategy.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

const TARGET_ADDRESS = process.env['HL_TARGET_ADDRESS'] ?? ''

const mockLog = createLogger('MockExecutor')
const log = createLogger('CopyTradingExample')

// Mock executor for dry-run mode — mirrors PerpTradingExecutor's accountTypes so
// the framework injects accounts and validation passes, but no real orders are placed.
class MockExecutor extends BaseExecutor<ExecutionInstruction> {
  get executorName() { return 'perp-trading' }
  get supportedActions() { return ['placeOrder', 'cancelOrder', 'setLeverage'] }
  override get accountTypes() { return [{ type: 'hyperliquid', label: 'trading' }] as const }

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

  if (!encryptionKey) throw new Error('OPENWHALE_ENCRYPTION_KEY is required')
  if (!walletAddress) throw new Error('HL_WALLET_ADDRESS is required')
  if (!privateKey)    throw new Error('HL_PRIVATE_KEY is required')
  if (!TARGET_ADDRESS) throw new Error('HL_TARGET_ADDRESS is required')

  // ── 2. Initialize database + CredentialStore ─────────────────────────────
  const dataDir  = process.env['OPENWHALE_DATA_DIR'] ?? join(homedir(), '.openwhale')
  const dbPath   = join(dataDir, 'openwhale.db')
  const database = new SQLiteAdapter({ filePath: dbPath })
  await database.initialize()

  const credentialStore = new DBCredentialStore(encryptionKey, database)

  // Store Hyperliquid credentials (written on first run; overwritten on subsequent runs).
  // The credential name 'HL Main' must match the name in StrategyInstance.accounts.
  await credentialStore.set('HL Main', 'hyperliquid', { walletAddress, privateKey })

  // ── 3. Initialize read-only adapter for the monitor ──────────────────────
  // The executor gets its adapter from the account (via CredentialStore), not from here.
  const readAdapter = new HyperliquidAdapter({ walletAddress })

  // ── 4. Assemble Runtime ───────────────────────────────────────────────────
  const runtime = new OpenWhaleRuntime({ database, credentialStore, dataDir })

  const now = new Date().toISOString()

  // Register Monitor: watch real-time fills for the target address
  runtime.registerMonitor(
    { id: 'user-trades', name: 'User Trades Monitor', source: 'builtin', createdAt: now, updatedAt: now },
    new UserTradesMonitor(readAdapter),
  )

  // Register Executor: MOCK_EXECUTOR=true logs instructions only; otherwise places real orders
  const isMock = process.env['MOCK_EXECUTOR'] === 'true'
  const executor = isMock ? new MockExecutor() : new PerpTradingExecutor()
  log.info({ mock: isMock }, 'Executor mode')
  runtime.registerExecutor(
    { id: 'perp-trading', name: isMock ? 'Mock Perp Trading Executor' : 'Perp Trading Executor', source: 'builtin', supportedActions: ['placeOrder', 'cancelOrder', 'setLeverage'], createdAt: now, updatedAt: now },
    executor,
  )

  // Register Strategy
  runtime.registerStrategy(
    { id: 'copy-trading', name: 'Copy Trading', source: 'builtin', monitorIds: ['user-trades'], executorIds: ['perp-trading'], createdAt: now, updatedAt: now },
    () => new CopyTradingStrategy(),
  )

  // Register AccountFactory: framework reads credentials from CredentialStore and calls this
  // factory at activate() time, passing the credential name and decrypted data.
  runtime.registerAccountFactory('hyperliquid', (name, data) =>
    new HyperliquidAccount(name, new HyperliquidAdapter({
      walletAddress: data['walletAddress'] as string,
      privateKey: data['privateKey'] as string,
    }))
  )

  // ── 5. Start Runtime ──────────────────────────────────────────────────────
  await runtime.start()

  // ── 6. Activate copy-trading strategy instance ────────────────────────────
  await runtime.activate({
    id: 'copy-trading-instance-1',
    name: `Copy ${TARGET_ADDRESS.slice(0, 8)}...`,
    strategyId: 'copy-trading',
    accounts: ['HL Main'],   // credential name — framework resolves to HyperliquidAccount at activate()
    params: {
      base: {
        targetAddress: TARGET_ADDRESS,
        ratio: 0.5,
        maxPositionUsd: 1000,
      },
      tunable: {
        minTradeUsd: 10,
        slippageTolerance: 0.005,
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
    await runtime.stop()
    await readAdapter.close()
    await database.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
