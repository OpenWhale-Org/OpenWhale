# OpenWhale

> 面向开发者的可组合交易策略引擎

OpenWhale 是一个 TypeScript 框架，用于构建自动化交易策略。核心设计理念是**插件化与可组合性**——Monitor、Strategy、Executor 三层完全解耦，Strategy 对交易所无感知、对执行方式无感知，任意组件可独立替换或自由组合，接口标准统一。

---

## 设计理念

### 三层解耦，自由组合

```
Monitor          Strategy          Executor
─────────        ─────────         ─────────
数据采集          纯决策逻辑          交易执行

UserTradesMonitor  ──→  CopyTradingStrategy  ──→  PerpTradingExecutor
PriceMonitor       ──→  MomentumStrategy     ──→  SpotTradingExecutor
FundingRateMonitor ──→  ArbitrageStrategy    ──→  MockExecutor
```

- **Monitor** 只负责采集数据并 emit 事件，不知道谁在消费
- **Strategy** 只负责决策，输出 `ExecutionInstruction[]`，不知道数据来自哪个交易所，也不知道指令由谁执行
- **Executor** 只负责消费指令队列，不知道指令从哪个策略来

三者通过标准接口连接，任意替换其中一层不影响其他层。同一个 Strategy 可以搭配不同的 Monitor 数据源，也可以搭配 MockExecutor 做模拟测试，无需修改策略代码。

### 插件化扩展

每个交易所或平台封装为独立插件，一次注册，全局可用：

```typescript
// 注册 Hyperliquid 插件后，Monitor / Strategy / Executor 均可使用
runtime.registerMonitor(...)
runtime.registerExecutor(...)
runtime.registerStrategy(...)
runtime.registerAccountFactory('hyperliquid', (data) => new HyperliquidAccount(data))
```

插件只需实现标准接口（`BaseMonitor`、`BaseExecutor`、`IAccount`），框架负责生命周期管理、依赖注入、参数校验。

### Strategy 与平台无关

Strategy 通过 `IAccount` 统一接口访问账户，通过 `ExecutionInstruction` 表达意图，不直接调用任何交易所 SDK：

```typescript
// Strategy 代码与平台完全无关
const account = this.account('main')          // IAccount 接口，不绑定平台
const { available } = await account.balance() // 统一字段，跨平台一致

return [{
  executorId: 'perp-trading',   // 声明意图，不关心由谁执行
  action: 'placeOrder',
  params: { symbol, side: 'buy', amount: 0.01 },
}]
```

同一个 Strategy 可以在 Hyperliquid、Binance、任意实现了标准接口的平台上运行。

---

## 架构

```
Monitor（数据采集）
    ↓ emit(key, data)
TriggerManager（触发决策）
    ↓ StrategyContext
Strategy（规则 / AI 推理）
    ↓ ExecutionInstruction[]
ExecutionQueue
    ↓
Executor（交易执行）
```

---

## 核心特性

- **插件化**：交易所、账户类型、Monitor、Executor 均通过标准接口注册，框架统一管理生命周期
- **可组合**：Monitor / Strategy / Executor 自由搭配，MockExecutor 一行切换模拟模式
- **Strategy 平台无关**：通过 `IAccount` 和 `ExecutionInstruction` 抽象，策略代码不绑定任何交易所
- **热加载**：AI 生成符合 `IStrategy` 接口的 TypeScript 代码，esbuild 编译后运行时热加载，无需重启
- **结构化触发**：Cron + Monitor 条件 AND 组合，window 内全部满足才触发
- **内置 LLM 推理**：策略内直接调用 LLM，支持结构化输出（Zod schema），支持 OpenAI / Anthropic / Google / Groq / xAI 等主流 provider
- **参数 UI Schema**：在 Zod schema 字段上附加 `.meta()` UI 元数据，Dashboard 自动派生通用表单，无需为每个策略单独写 UI
- **类型安全参数**：`baseParamsSchema`（必填）+ `tunableParamsSchema`（AI 可优化，有默认值），`activate()` 时自动校验注入
- **持久化存储**：Monitor 数据自动持久化为 JSONL，策略内置 KV store，支持 SQLite

---

## Packages

| Package | 说明 |
|---------|------|
| [`@openwhale/core`](./packages/core) | 策略引擎核心：Monitor、Trigger、Strategy、Executor、Runtime、Account、CompiledLoader 等全部模块 |
| [`@openwhale/hyperliquid`](./packages/hyperliquid) | Hyperliquid 插件：HyperliquidAdapter（ccxt.pro）、HyperliquidAccount、UserTradesMonitor、PerpTradingExecutor、CopyTradingStrategy |
| [`@openwhale/dashboard`](./packages/dashboard) | Next.js 管理面板：策略实例管理、注册表查看、凭证管理，支持通用参数表单渲染 |
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

  // Zod schema 是参数的唯一来源
  // 通过 .meta() 附加 UI 元数据，Dashboard 自动渲染对应表单
  readonly baseParamsSchema = z.object({
    symbol: z.string()
      .meta({ displayName: 'Symbol', placeholder: 'BTC/USDC:USDC' }),
  })

  readonly tunableParamsSchema = z.object({
    threshold: z.number().default(100_000)
      .meta({ displayName: 'Price Threshold', description: 'Trigger above this price' }),
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

## 参数 UI Schema

在 Zod schema 字段上通过 `.meta()` 附加 UI 元数据，`BaseStrategy.paramsFields` getter 自动派生 `ParamFieldDef[]`，Dashboard 通用表单渲染器据此生成对应控件，无需为每个策略单独写 UI 代码。

```typescript
readonly baseParamsSchema = z.object({
  targetAddress: z.string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .meta({ displayName: 'Target Address', placeholder: '0x...' }),

  ratio: z.number().positive().max(10)
    .meta({ displayName: 'Ratio', description: "Fraction of target's trade size" }),
})

readonly tunableParamsSchema = z.object({
  slippageTolerance: z.number().min(0).max(1).default(0.005)
    .meta({ displayName: 'Slippage Tolerance', placeholder: '0.005' }),
})
```

`.meta()` 是可选的，没有 meta 的字段以字段名作为 displayName 降级渲染。支持的 meta 字段：`displayName`、`description`、`hint`、`placeholder`、`options`（枚举）、`displayOptions`（条件显示）。

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

运行示例：

```bash
cd packages/hyperliquid
cp examples/.env.example examples/.env   # 填入钱包地址和私钥
pnpm example:copy-trading
```

---

## Dashboard

```bash
cd packages/dashboard
pnpm dev
```

访问 `http://localhost:3000`，可管理策略实例、查看 Monitor 数据、管理凭证。

策略参数表单根据 `paramsFields` 自动渲染，无需手动配置 UI。

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
- [`03-monitor.md`](./design/03-monitor.md) — Monitor 设计
- [`06-strategy.md`](./design/06-strategy.md) — Strategy 设计
- [`04-adapter.md`](./design/04-adapter.md) — Adapter 接口设计
- [`09-runtime.md`](./design/09-runtime.md) — Runtime 设计

---

## License

MIT
