/**
 * Example: 完整 Runtime 组装
 *
 * 展示如何将 Monitor、Executor、Strategy 注册到 OpenWhaleRuntime，
 * 并激活 Bundle 让整个系统运转起来。
 *
 * 运行方式（仅供参考，需要先 build）：
 *   npx tsx packages/core/examples/runtime-setup.ts
 */

import { OpenWhaleRuntime } from '../src/runtime/OpenWhaleRuntime.js'
import { CredentialStore } from '../src/credentials/CredentialStore.js'
import { PriceMonitor } from './PriceMonitor.js'
import { TradeExecutor } from './TradeExecutor.js'
import { MomentumStrategy } from './MomentumStrategy.js'
import { AiTradingStrategy } from './AiTradingStrategy.js'

async function main() {
  // ── 1. 初始化 CredentialStore ─────────────────────────────────────────────
  // 加密密钥从环境变量读取，生产环境应使用 KMS 或 Vault
  const encryptionKey = process.env['OPENWHALE_ENCRYPTION_KEY']
  if (!encryptionKey) throw new Error('OPENWHALE_ENCRYPTION_KEY is required')

  const credentials = new CredentialStore(encryptionKey)

  // 存储 API Key（首次运行时执行，之后注释掉）
  // await credentials.set({ name: 'openai-api-key', value: process.env['OPENAI_API_KEY'] ?? '' })

  // ── 2. 创建 Runtime ───────────────────────────────────────────────────────
  const runtime = new OpenWhaleRuntime({ credentialStore: credentials })

  // ── 3. 注册 Monitor ───────────────────────────────────────────────────────
  const priceMonitor = new PriceMonitor(5000)  // 5 秒轮询

  runtime.registerMonitor(
    { id: 'price', name: 'Price Monitor', monitorName: 'price' },
    priceMonitor,
  )

  // ── 4. 注册 Executor ──────────────────────────────────────────────────────
  const tradeExecutor = new TradeExecutor()

  runtime.registerExecutor(
    { id: 'trade', name: 'Trade Executor', executorName: 'trade', executorIds: ['trade'] },
    tradeExecutor,
  )

  // ── 5. 注册 Strategy ──────────────────────────────────────────────────────
  const momentumStrategy = new MomentumStrategy({ shortWindow: 5, longWindow: 20 })
  const aiStrategy = new AiTradingStrategy(['BTC', 'ETH'])

  runtime.registerStrategy(
    { id: 'momentum', name: 'Momentum Strategy', strategyId: 'momentum', executorIds: ['trade'] },
    momentumStrategy,
  )
  runtime.registerStrategy(
    { id: 'ai-trading', name: 'AI Trading Strategy', strategyId: 'ai-trading', executorIds: ['trade'] },
    aiStrategy,
  )

  // ── 6. 激活 Bundle ────────────────────────────────────────────────────────
  const now = new Date().toISOString()

  // Bundle A：BTC 价格变动时触发 MomentumStrategy
  await runtime.activate({
    id: 'bundle-momentum-btc',
    name: 'BTC Momentum',
    strategyId: 'momentum',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    triggers: [
      {
        id: 'trigger-price-btc',
        strategyBundleId: 'bundle-momentum-btc',
        enabled: true,
        conditions: [
          {
            type: 'monitor',
            sources: [
              {
                monitorName: 'price',
                key: 'BTC',
                // 可选 filter：只在价格变动超过 1% 时触发
                // filter: { field: 'change24h', op: 'gt', value: 1 },
              },
            ],
          },
        ],
      },
    ],
  })

  // Bundle B：每分钟触发 AiTradingStrategy
  await runtime.activate({
    id: 'bundle-ai-trading',
    name: 'AI Trading (1m)',
    strategyId: 'ai-trading',
    enabled: true,
    createdAt: now,
    updatedAt: now,
    triggers: [
      {
        id: 'trigger-cron-1m',
        strategyBundleId: 'bundle-ai-trading',
        enabled: true,
        conditions: [
          { type: 'cron', expression: '* * * * *' },  // 每分钟
        ],
      },
    ],
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
