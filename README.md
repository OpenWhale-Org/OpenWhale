# OpenWhale

> 面向开发者的 AI 交易策略引擎框架

OpenWhale 是一个 TypeScript 框架，用于构建由 AI 驱动的自动化交易策略。核心思路是：**AI 生成策略代码，而不是每次实时推理**——策略编译后持久运行，只在需要进化时才重新调用 LLM，执行效率更高，成本更低。

---

## 核心特性

- **四层解耦架构**：Monitor / TriggerManager / Strategy / Executor 各司其职，任意一层可独立替换
- **AI 生成 + 热加载**：AI 生成符合 `IStrategy` 接口的 TypeScript 代码，esbuild 编译后运行时热加载，无需重启
- **结构化触发系统**：支持 Cron + Monitor 条件 AND 组合，window 内全部满足才触发
- **内置 LLM 推理**：策略内直接调用 LLM，支持结构化输出（Zod schema），支持 OpenAI / Anthropic / Google / Groq / xAI 等主流 provider
- **Account 账户接口**：统一的账户查询接口（余额/持仓/挂单/PnL），平台实现通过工厂函数注册，策略按 index 或 label 访问
- **类型安全参数系统**：`baseParamsSchema`（必填）+ `tunableParamsSchema`（AI 可优化，有默认值），`activate()` 时自动校验注入
- **持久化存储**：Monitor 数据自动持久化为 JSONL，策略内置 KV store，支持 SQLite

---

## 架构

```
Monitor（数据采集）
    ↓ emit(key, data)
TriggerManager（触发决策）
    ↓ StrategyContext
Strategy（AI 推理 / 规则决策）
    ↓ ExecutionInstruction[]
Executor（交易执行）
```

---

## 安装

```bash
pnpm install
pnpm build
```

环境要求：Node.js >= 20，pnpm >= 8

---

## 快速上手

### 1. 实现 Monitor

```typescript
import { BaseMonitor, MonitorMode } from '@openwhale/core'

class PriceMonitor extends BaseMonitor {
  readonly monitorId = 'price'
  readonly mode = MonitorMode.Subscribe

  protected async startSubscribe(key: string) {
    // 启动针对 key 的数据采集（REST 轮询、WebSocket 等）
  }
  protected stopSubscribe(key: string) { /* 释放资源 */ }
}
```

### 2. 实现 Strategy

```typescript
import { BaseStrategy } from '@openwhale/core'
import { z } from 'zod'

class MyStrategy extends BaseStrategy {
  readonly strategyId = 'my-strategy'
  readonly monitors = ['price']
  readonly accountTypes = [{ type: 'hyperliquid', label: 'main' }] as const

  readonly baseParamsSchema = z.object({
    symbol: z.string(),
  })
  readonly tunableParamsSchema = z.object({
    threshold: z.number().default(100000),
  })

  triggers(params: StrategyParams) {
    return [{ cron: '*/5 * * * *' }]
  }

  async evaluate(context: StrategyContext) {
    const { symbol } = this.params.base as { symbol: string }
    const { threshold } = this.params.tunable as { threshold: number }

    const price = await this.monitorData('price')?.readLatest(symbol)
    const account = this.account('main')
    const { available } = await account.balance()

    return this.when(price > threshold && available > 100, [
      { executorId: 'trade', messageId: '', action: 'buy', params: { symbol } }
    ])
  }
}
```

### 3. 实现 Executor

```typescript
import { BaseExecutor } from '@openwhale/core'

class TradeExecutor extends BaseExecutor {
  readonly executorId = 'trade'

  async execute(instruction: ExecutionInstruction) {
    // 调用交易所 API
  }
}
```

### 4. 注册 Account

```typescript
// 框架不内置任何平台实现，通过工厂函数注册
runtime.registerAccountFactory('hyperliquid', (data) => new HyperliquidAccount(data))
```

### 5. 组装运行时

```typescript
import { OpenWhaleRuntime, SQLiteAdapter } from '@openwhale/core'

const runtime = new OpenWhaleRuntime({
  database: new SQLiteAdapter({ path: './data/openwhale.db' }),
  credentialStore: myCredentialStore,
})

runtime.registerMonitor({ id: 'price' }, new PriceMonitor())
runtime.registerExecutor({ id: 'trade' }, new TradeExecutor())
runtime.registerStrategy({ id: 'my-strategy' }, () => new MyStrategy())
runtime.registerAccountFactory('hyperliquid', (data) => new HyperliquidAccount(data))

await runtime.activate({
  id: 'instance-1',
  name: 'BTC 突破策略',
  strategyId: 'my-strategy',
  accounts: ['HL Main'],
  params: {
    base: { symbol: 'BTC' },
    tunable: { threshold: 100000 },
  },
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

await runtime.start()
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
// decision: { action: 'buy' | 'sell' | 'hold', reason: string }
```

在 `StrategyOptions` 中配置 provider：

```typescript
class AiStrategy extends BaseStrategy {
  constructor() {
    super({ llm: { defaultModel: 'anthropic:claude-sonnet-4-6' } })
    // CredentialStore 中需存储 'anthropic-api-key'
  }
}
```

支持的内置 provider：`openai` / `anthropic` / `google` / `mistral` / `cohere` / `groq` / `xai`，也支持自定义 provider。

---

## Packages

| Package | 说明 |
|---------|------|
| `@openwhale/core` | 策略引擎核心：Monitor、Trigger、Strategy、Executor、Runtime、Account、CompiledLoader 等全部模块 |
| `@openwhale/assistant` | 个人助理层：Session 管理、LLM 对话、工具调用（规划中） |
| `@openwhale/mcp-server` | 将策略引擎暴露为 MCP Server（规划中） |

---

## 设计文档

详细设计见 [`design/`](./design/) 目录，[`docs/`](./docs/) 目录包含：

- [introduction.md](./docs/introduction.md) — 框架特性详细介绍
- [competitive-analysis.md](./docs/competitive-analysis.md) — 与同类框架的对比分析

---

## License

MIT
