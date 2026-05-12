/**
 * Example: Hyperliquid CopyTrading 完整示例
 *
 * 展示如何用 @openwhale/hyperliquid 包搭建一个跟单机器人：
 *   1. 初始化 HyperliquidAdapter
 *   2. 注册 UserTradesMonitor（监听目标地址成交）
 *   3. 注册 PerpTradingExecutor（执行下单）
 *   4. 注册 HyperliquidAccount（账户查询）
 *   5. 激活 CopyTradingStrategy 实例
 *
 * ── 所需环境变量 ──────────────────────────────────────────────────────────────
 *
 *   OPENWHALE_ENCRYPTION_KEY   必填  数据库加密密钥（任意非空字符串，建议 32 字节 hex）
 *                                    生成示例：openssl rand -hex 32
 *
 *   HL_WALLET_ADDRESS          必填  你的 Hyperliquid 钱包地址（0x...）
 *
 *   HL_PRIVATE_KEY             必填  对应私钥（0x...），用于签名下单请求
 *                                    ⚠️  不要提交到版本控制，建议存入 .env 文件
 *
 * ── 可选环境变量 ──────────────────────────────────────────────────────────────
 *
 *   OPENWHALE_DATA_DIR         可选  数据目录，默认 ~/.openwhale
 *
 * ── 运行方式 ──────────────────────────────────────────────────────────────────
 *
 *   # 安装依赖
 *   pnpm install
 *
 *   # 设置环境变量（或创建 .env 文件后用 dotenv 加载）
 *   export OPENWHALE_ENCRYPTION_KEY="$(openssl rand -hex 32)"
 *   export HL_WALLET_ADDRESS="0xYourWalletAddress"
 *   export HL_PRIVATE_KEY="0xYourPrivateKey"
 *
 *   # 运行
 *   npx tsx packages/hyperliquid/examples/copy-trading.ts
 */

import { OpenWhaleRuntime, DBCredentialStore, SQLiteAdapter } from '@openwhale/core'
import { HyperliquidAdapter } from '../src/adapter.js'
import { HyperliquidAccount } from '../src/account.js'
import { UserTradesMonitor } from '../src/monitor.js'
import { PerpTradingExecutor } from '../src/executor.js'
import { CopyTradingStrategy } from '../src/strategy.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 目标跟单地址（从环境变量读取） ────────────────────────────────────────────
const TARGET_ADDRESS = process.env['HL_TARGET_ADDRESS'] ?? ''

async function main() {
  // ── 1. 读取环境变量 ───────────────────────────────────────────────────────
  const encryptionKey = process.env['OPENWHALE_ENCRYPTION_KEY']
  const walletAddress = process.env['HL_WALLET_ADDRESS']
  const privateKey    = process.env['HL_PRIVATE_KEY']

  if (!encryptionKey) throw new Error('OPENWHALE_ENCRYPTION_KEY is required')
  if (!walletAddress) throw new Error('HL_WALLET_ADDRESS is required')
  if (!privateKey)    throw new Error('HL_PRIVATE_KEY is required')
  if (!TARGET_ADDRESS) throw new Error('HL_TARGET_ADDRESS is required')

  // ── 2. 初始化数据库 + CredentialStore ────────────────────────────────────
  const dataDir  = process.env['OPENWHALE_DATA_DIR'] ?? join(homedir(), '.openwhale')
  const dbPath   = join(dataDir, 'openwhale.db')
  const database = new SQLiteAdapter({ filePath: dbPath })
  await database.initialize()

  // DBCredentialStore(masterKey, db)
  const credentialStore = new DBCredentialStore(encryptionKey, database)

  // 将 Hyperliquid 凭证存入加密数据库（首次运行时写入，后续覆盖更新）
  // 凭证名称 'HL Main' 需与 StrategyInstance.accounts 中的名称一致
  await credentialStore.set('HL Main', 'hyperliquid', { walletAddress, privateKey })

  // ── 3. 初始化 HyperliquidAdapter ─────────────────────────────────────────
  // Adapter 是底层，Account 和 Executor 共享同一实例，避免重复建立连接
  const hlAdapter = new HyperliquidAdapter({ walletAddress, privateKey })

  // ── 4. 组装 Runtime ───────────────────────────────────────────────────────
  const runtime = new OpenWhaleRuntime({ database, credentialStore, dataDir })

  // 注册 Monitor：监听目标地址的实时成交
  const now = new Date().toISOString()
  runtime.registerMonitor(
    { id: 'user-trades', name: 'User Trades Monitor', source: 'builtin', createdAt: now, updatedAt: now },
    new UserTradesMonitor(hlAdapter),
  )

  // 注册 Executor：执行永续合约下单
  runtime.registerExecutor(
    { id: 'perp-trading', name: 'Perp Trading Executor', source: 'builtin', supportedActions: ['placeOrder', 'cancelOrder', 'setLeverage'], createdAt: now, updatedAt: now },
    new PerpTradingExecutor(hlAdapter),
  )

  // 注册 Strategy
  runtime.registerStrategy(
    { id: 'copy-trading', name: 'Copy Trading', source: 'builtin', monitorIds: ['user-trades'], executorIds: ['perp-trading'], createdAt: now, updatedAt: now },
    () => new CopyTradingStrategy(),
  )

  // 注册 AccountFactory：框架在 activate() 时从 CredentialStore 读取凭证并调用此工厂
  runtime.registerAccountFactory('hyperliquid', (data) =>
    new HyperliquidAccount('HL Main', new HyperliquidAdapter({
      walletAddress: data['walletAddress'] as string,
      privateKey: data['privateKey'] as string,
    }))
  )

  // ── 5. 启动 Runtime ───────────────────────────────────────────────────────
  await runtime.start()

  // ── 6. 激活跟单策略实例 ───────────────────────────────────────────────────
  await runtime.activate({
    id: 'copy-trading-instance-1',
    name: `跟单 ${TARGET_ADDRESS.slice(0, 8)}...`,
    strategyId: 'copy-trading',
    accounts: ['HL Main'],   // 对应 credentialStore 中的凭证名称
    params: {
      base: {
        targetAddress: TARGET_ADDRESS,
        ratio: 0.5,           // 跟单比例：目标仓位的 50%
        maxPositionUsd: 1000, // 单个仓位最大 1000 USD
      },
      tunable: {
        minTradeUsd: 20,          // 低于 20 USD 的成交忽略
        slippageTolerance: 0.005, // 0.5% 滑点容忍
      },
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
  })

  console.log(`CopyTrading started — tracking ${TARGET_ADDRESS}`)
  console.log('Press Ctrl+C to stop')

  // ── 7. 优雅退出 ───────────────────────────────────────────────────────────
  process.on('SIGINT', async () => {
    console.log('\nShutting down...')
    await runtime.stop()
    await hlAdapter.close()
    await database.close()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
