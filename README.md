# OpenWhale

> 面向开发者的 AI 交易策略引擎框架

OpenWhale 是一个 TypeScript 框架，用于构建自动化交易策略。核心思路是 **AI 生成策略代码，而不是每次实时推理**——策略编译后持久运行，只在需要进化时才重新调用 LLM，执行效率更高，成本更低。

---

## 架构

```
Monitor（数据采集）
    ↓ emit(key, data)
TriggerManager（触发决策）
    ↓ StrategyContext
Strategy（规则 / AI 推理）
    ↓ ExecutionInstruction[]
Executor（交易执行）
```

四层完全解耦，任意一层可独立替换或扩展。

---

## 核心特性

- **热加载**：AI 生成符合 `IStrategy` 接口的 TypeScript 代码，esbuild 编译后运行时热加载，无需重启
- **结构化触发**：Cron + Monitor 条件 AND 组合，window 内全部满足才触发
- **内置 LLM 推理**：策略内直接调用 LLM，支持结构化输出（Zod schema），支持 OpenAI / Anthropic / Google / Groq / xAI 等主流 provider
- **统一账户接口**：`IAccount` 抽象余额 / 持仓 / 挂单 / PnL，平台实现通过工厂函数注册
- **类型安全参数**：`baseParamsSchema`（必填）+ `tunableParamsSchema`（AI 可优化，有默认值），`activate()` 时自动校验注入
- **持久化存储**：Monitor 数据自动持久化为 JSONL，策略内置 KV store，支持 SQLite

---

## Packages

| Package | 说明 |
|---------|------|
| [`@openwhale/core`](./packages/core) | 策略引擎核心：Monitor、Trigger、Strategy、Executor、Runtime、Account、CompiledLoader 等全部模块 |
| [`@openwhale/hyperliquid`](./packages/hyperliquid) | Hyperliquid 插件：HyperliquidAdapter（ccxt.pro）、HyperliquidAccount、UserTradesMonitor、PerpTradingExecutor、CopyTradingStrategy |
| [`@openwhale/dashboard`](./packages/dashboard) | Next.js 管理面板：策略实例管理、注册表、Monitor 数据查看、凭证管理 |
| `@openwhale/assistant` | 个人助理层：Session 管理、LLM 对话、工具调用（规划中） |
| `@openwhale/mcp-server` | 将策略引擎暴露为 MCP Server（规划中） |

---

## 安装

```bash
pnpm install
pnpm build
```

环境要求：Node.js >= 20，pnpm >= 8

---

## 快速上手

### 1. Monitor — 数据采集

```typescript
import { BaseMonitor, MonitorMode } from '@openwhale/core'

class PriceMonitor extends BaseMonitor<string, { price: number }> {
  readonly mode = MonitorMode.Subscribe

  protected async startSubscribe(key: string) {
    // key = 交易对，如 'BTC/USDT'
    // 启动 WebSocket / 轮询，调用 this.emit(key, { price }) 推送数据
  }

  protected stopSubscribe(key: string) {
    // 释放资源
  }
}
```

### 2. Strategy — 决策逻辑

```typescript
import { BaseStrategy, type StrategyContext } from '@openwhale/core'
import { z } from 'zod'

class MyStrategy extends BaseStrategy {
  readonly strategyId = 'my-strategy'
  readonly monitors = ['price'] as const
  readonly accountTypes = [{ type: 'hyperliquid', label: 'main' }] as const

  readonly baseParamsSchema = z.object({
    symbol: z.string(),
  })
  readonly tunableParamsSchema = z.object({
    threshold: z.number().default(100_000),
  })

  triggers(params) {
    return [{ cron: '*/5 * * * *' }]
  }

  async evaluate(context: StrategyContext) {
    const { symbol } = this.params.base
    const { threshold } = this.params.tunable

    const latest = context.monitorData['price']?.[symbol]
    const account = this.account('main')
    const { available } = await account.balance()

    if (!latest || latest.price < threshold || available < 100) return []

    return [{
      executorId: 'perp-trading',
      action: 'placeOrder',
      params: { symbol, side: 'buy', amount: 0.01 },
    }]
  }
}
```

### 3. Executor — 交易执行

```typescript
import { BaseExecutor, type ExecutionInstruction } from '@openwhale/core'

class TradeExecutor extends BaseExecutor<ExecutionInstruction> {
  get executorName() { return 'perp-trading' }
  get supportedActions() { return ['placeOrder', 'cancelOrder'] }

  async execute(instruction: ExecutionInstruction) {
    // 调用交易所 API
  }
}
```

### 4. 组装运行时

```typescript
import { OpenWhaleRuntime, SQLiteAdapter, DBCredentialStore } from '@openwhale/core'

const now = new Date().toISOString()
const database = new SQLiteAdapter({ filePath: './data/openwhale.db' })
const credentialStore = new DBCredentialStore(process.env.MASTER_KEY!, database)
const runtime = new OpenWhaleRuntime({ database, credentialStore })

runtime.registerMonitor(
  { id: 'price', name: 'Price Monitor', source: 'custom', createdAt: now, updatedAt: now },
  new PriceMonitor(),
)
runtime.registerExecutor(
  { id: 'perp-trading', name: 'Perp Trading', source: 'custom', supportedActions: ['placeOrder'], createdAt: now, updatedAt: now },
  new TradeExecutor(),
)
runtime.registerStrategy(
  { id: 'my-strategy', name: 'My Strategy', source: 'custom', monitorIds: ['price'], executorIds: ['perp-trading'], createdAt: now, updatedAt: now },
  () => new MyStrategy(),
)
runtime.registerAccountFactory('hyperliquid', (data) =>
  new HyperliquidAccount('main', new HyperliquidAdapter(data))
)

await runtime.start()

await runtime.activate({
  id: 'instance-1',
  name: 'BTC 突破策略',
  strategyId: 'my-strategy',
  accounts: ['HL Main'],
  params: { base: { symbol: 'BTC/USDC:USDC' }, tunable: { threshold: 100_000 } },
  enabled: true,
  createdAt: now,
  updatedAt: now,
})
```

---

## 内置 LLM 推理

策略内直接调用 LLM，支持结构化输出：

```typescript
const decision = await this.llm({
  messages: [
    { role: 'system', content: '你是一个交易分析师。' },
    { role: 'user', content: JSON.stringify(marketData) },
  ],
  schema: z.object({
    action: z.enum(['buy', 'sell', 'hold']),
    reason: z.string(),
  }),
})
// decision.action: 'buy' | 'sell' | 'hold'
```

在策略构造函数中配置 provider：

```typescript
class AiStrategy extends BaseStrategy {
  constructor() {
    super({ llm: { defaultModel: 'anthropic:claude-sonnet-4-6' } })
    // CredentialStore 中需存储对应的 API key
  }
}
```

支持的内置 provider：`openai` / `anthropic` / `google` / `mistral` / `cohere` / `groq` / `xai`

---

## Hyperliquid 插件

`@openwhale/hyperliquid` 提供开箱即用的 Hyperliquid 支持：

```typescript
import {
  HyperliquidAdapter,
  HyperliquidAccount,
  UserTradesMonitor,
  PerpTradingExecutor,
  CopyTradingStrategy,
} from '@openwhale/hyperliquid'

// 跟单策略示例
runtime.registerMonitor(..., new UserTradesMonitor(adapter))     // 监听任意地址的实时成交
runtime.registerExecutor(..., new PerpTradingExecutor(adapter))  // 下单 / 撤单 / 调整杠杆
runtime.registerStrategy(..., () => new CopyTradingStrategy())   // 按比例跟单，支持仓位上限
runtime.registerAccountFactory('hyperliquid', (data) =>
  new HyperliquidAccount('main', new HyperliquidAdapter(data))
)
```

完整示例见 [`packages/hyperliquid/examples/copy-trading.ts`](./packages/hyperliquid/examples/copy-trading.ts)。

---

## Dashboard

```bash
cd packages/dashboard
pnpm dev
```

访问 `http://localhost:3000`，可管理策略实例、查看 Monitor 数据、导入自定义组件、管理凭证。

环境变量（`.env.local`）：

```env
OPENWHALE_MASTER_KEY=your-32-byte-hex-key
OPENWHALE_DB_PATH=/path/to/openwhale.db   # 可选，默认 ~/.openwhale/openwhale.db
HL_WALLET_ADDRESS=0x...                   # Hyperliquid 只读地址（用于 Monitor）
```

---

## 设计文档

详细设计见 [`design/`](./design/) 目录：

- [`01-overview.md`](./design/01-overview.md) — 整体架构
- [`02-monitor.md`](./design/02-monitor.md) — Monitor 设计
- [`03-strategy.md`](./design/03-strategy.md) — Strategy 设计
- [`04-adapter.md`](./design/04-adapter.md) — Adapter 接口设计

---

## License

MIT
