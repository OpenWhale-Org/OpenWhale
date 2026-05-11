# OpenWhale 介绍

> 面向开发者的 AI 交易策略引擎框架

---

## 是什么

OpenWhale 是一个 TypeScript 框架，用于构建由 AI 驱动的自动化交易策略。

它解决的核心问题是：**如何让 AI 不只是"给出建议"，而是真正生成可运行、可进化、可审查的交易策略代码**，并在运行时自动热加载，无需人工干预。

---

## 核心理念

### AI 是程序员，不是决策者

大多数 AI 交易工具让 LLM 在每个交易周期实时推理，给出"买"或"卖"的指令。这有两个问题：每次都消耗 token，且决策逻辑无法复用。

OpenWhale 的做法不同：**AI 生成策略代码**，代码编译后持久运行，只在需要进化时才重新调用 LLM。策略逻辑固化在代码里，执行效率更高，成本更低。

### 策略即代码，代码即接口

AI 生成的策略必须实现 `IStrategy` 接口，经过 esbuild 编译，类型系统在编译期保证正确性。生成的是标准 TypeScript 文件，可以 code review，可以 git 版本控制，不是黑盒字符串。

### 四层解耦，任意替换

```
Monitor（数据采集）
    ↓
TriggerManager（触发决策）
    ↓
Strategy（AI 推理 / 规则决策）
    ↓
Executor（交易执行）
```

每一层都是纯接口，可以独立替换。换交易所不需要改策略，换策略不需要改数据采集，换触发条件不需要改执行逻辑。

---

## 核心特性

### 结构化触发系统

触发条件由策略自身通过 `triggers(params)` 方法声明，`TriggerManager` 支持 Cron 和 Monitor 条件的 AND 组合，并支持时间窗口约束：

```typescript
class MyStrategy extends BaseStrategy {
  triggers(params: StrategyParams) {
    return [{
      cron: '*/5 * * * *',           // 每 5 分钟检查一次
      conditions: [
        { monitor: 'price', key: 'BTC', threshold: ... },
        { monitor: 'volume', key: 'BTC', threshold: ... },
      ],
      window: 60_000,                // 两个条件必须在 60 秒内同时满足
    }]
  }
}
```

触发条件是策略逻辑的一部分，随策略代码一起版本控制。这类"A 和 B 在 60 秒内同时发生"的复杂条件，在其他框架里需要手写状态机，OpenWhale 原生支持。

### AI 生成策略 + 热加载

```typescript
// AI 生成符合 IStrategy 接口的 TypeScript 代码
// CompiledLoader 用 esbuild 编译，运行时热加载
await compiledLoader.recompile('my-strategy')
// 无需重启进程，新策略立即生效
```

### 内置 LLM 推理（结构化输出）

策略内可以直接调用 LLM，返回类型安全的结构化结果：

```typescript
class MyStrategy extends BaseStrategy {
  readonly strategyId = 'my-strategy'

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const data = await this.monitorData('price')?.readLatest('BTC')

    const decision = await this.llm({
      messages: [
        { role: 'system', content: '你是一个交易分析师。' },
        { role: 'user', content: JSON.stringify(data) },
      ],
      schema: z.object({
        action: z.enum(['buy', 'sell', 'hold']),
        reason: z.string(),
        confidence: z.number(),
      }),
    })

    return this.when(decision.action !== 'hold', [
      { executorId: 'trade', messageId: '', action: decision.action, params: {} }
    ])
  }
}
```

支持 OpenAI、Anthropic、Google、Mistral、Groq、xAI 等主流 provider，也支持自定义 provider。

### 显式依赖声明

策略通过 `monitors` 字段声明数据依赖，运行时自动注入：

```typescript
class MyStrategy extends BaseStrategy {
  readonly strategyId = 'my-strategy'
  readonly monitors = ['price', 'volume']  // 声明依赖

  async evaluate(context: StrategyContext) {
    const price = await this.monitorData('price')?.readLatest('BTC')
    const volume = await this.monitorData('volume')?.readLatest('BTC')
    // ...
  }
}
```

依赖在启动时校验，缺少 Monitor 会立即报错，不会在运行时静默失败。

### 持久化 KV 存储

策略内置持久化存储，数据在进程重启后保留：

```typescript
// 记录上次触发价格
await this.store.set('lastPrice', currentPrice)
const lastPrice = await this.store.get<number>('lastPrice')
```

支持 SQLite（本地）和可扩展的数据库适配器。

### 类型安全的参数系统

策略通过 Zod schema 声明参数，框架在 `activate()` 时自动校验并注入：

```typescript
class MyStrategy extends BaseStrategy {
  // base: 必填参数，无默认值
  readonly baseParamsSchema = z.object({
    symbol: z.string(),
    maxPositionUsd: z.number(),
  })

  // tunable: AI 可优化参数，必须有默认值
  readonly tunableParamsSchema = z.object({
    buyThreshold: z.number().default(0.02),
    sellThreshold: z.number().default(0.03),
  })

  async evaluate(context: StrategyContext) {
    const { symbol, maxPositionUsd } = this.params.base as { symbol: string; maxPositionUsd: number }
    const { buyThreshold } = this.params.tunable as { buyThreshold: number }
    // ...
  }
}
```

`tunable` 参数是 AI 优化器的目标——框架可以自动调整这些参数，无需修改策略代码。

### Account：账户查询接口

策略通过 `accountTypes` 声明需要哪些类型的交易账户，框架在 `activate()` 时校验并注入：

```typescript
class ArbitrageStrategy extends BaseStrategy {
  // 声明需要两个账户，并给它们起 label
  readonly accountTypes = [
    { type: 'hyperliquid', label: 'main' },
    { type: 'binance',     label: 'hedge' },
  ] as const

  async evaluate(context: StrategyContext) {
    // 按 label 访问，cast 到平台特定接口获取扩展字段
    const hl = this.account<IPerpAccount>('main')
    const balance = await hl.balance()
    const positions = await hl.positions()
    // positions[0].liquidationPrice — 永续合约特有字段

    const bn = this.account<IAccount>('hedge')
    const bnBalance = await bn.balance()
  }
}
```

`IAccount` 是最小公约数接口（余额、持仓、挂单、PnL、历史记录），各平台通过接口继承扩展特定字段（如永续合约的 `marginRatio`、`liquidationPrice`）。

Account 实例在 Runtime 级别缓存，同一 Credential 被多个策略实例共享，不会重复创建连接。

注册平台实现：

```typescript
// 框架不内置任何平台，通过工厂函数注册
runtime.registerAccountFactory(
  'hyperliquid',
  (data) => new HyperliquidAccount(data)
)
```

`activate()` 时框架自动校验：账户数量是否匹配、每个 Credential 的 `type` 是否与 `accountTypes` 对应、对应的 AccountFactory 是否已注册——任一不满足直接抛错，不等到触发时才发现。

### 策略自动进化闭环

Monitor 数据自动持久化为 JSONL → Strategy 读取历史数据 → AI 分析后重新生成策略代码 → `recompile()` 热加载，形成完整的自动进化闭环，无需人工干预。

---

## 架构组件

| 组件 | 职责 |
|------|------|
| `BaseMonitor` | 数据采集抽象，支持 WebSocket（Standalone）和轮询（Subscribe）两种模式，数据自动持久化为 JSONL |
| `TriggerManager` | 管理触发条件，支持 Cron + Monitor AND 组合，window 内全部满足才触发 |
| `BaseStrategy` | 策略基类，提供 LLM 推理、Monitor 数据读取、Account 访问、参数注入、持久化存储、HTTP 客户端等能力 |
| `BaseExecutor` | 执行器基类，消费 ExecutionQueue，执行交易指令 |
| `IAccount` | 账户查询接口（余额/持仓/挂单/PnL/历史），由 AccountFactory 创建，Runtime 级别缓存共享 |
| `CompiledLoader` | 用 esbuild 编译 AI 生成的 TypeScript 策略代码，支持运行时热加载 |
| `OpenWhaleRuntime` | 运行时入口，管理组件注册、账户工厂、实例生命周期、启动/停止 |
| `PluginManager` | 插件系统，支持打包分发 Monitor + Executor + Strategy + AccountFactory 组合 |

---

## 快速上手

```typescript
import {
  OpenWhaleRuntime,
  BaseMonitor,
  BaseStrategy,
  BaseExecutor,
  SQLiteAdapter,
} from '@openwhale/core'
import { z } from 'zod'

// 1. 实现 Monitor（数据采集）
class PriceMonitor extends BaseMonitor {
  readonly monitorId = 'price'
  async fetch(key: string) {
    // 返回当前价格数据
  }
}

// 2. 实现 Strategy（决策）
class MyStrategy extends BaseStrategy {
  readonly strategyId = 'my-strategy'
  readonly monitors = ['price']
  readonly accountTypes = [{ type: 'hyperliquid', label: 'main' }] as const

  readonly baseParamsSchema = z.object({ symbol: z.string() })
  readonly tunableParamsSchema = z.object({ threshold: z.number().default(100000) })

  // 触发条件由策略自身声明
  triggers(params: StrategyParams) {
    return [{ cron: '*/1 * * * *' }]
  }

  async evaluate(context: StrategyContext) {
    const { symbol } = this.params.base as { symbol: string }
    const { threshold } = this.params.tunable as { threshold: number }

    const price = await this.monitorData('price')?.readLatest(symbol)
    const account = this.account('main')
    const balance = await account.balance()

    return this.when(price > threshold && balance.available > 100, [
      { executorId: 'trade', messageId: '', action: 'buy', params: { symbol } }
    ])
  }
}

// 3. 实现 Executor（执行）
class TradeExecutor extends BaseExecutor {
  readonly executorId = 'trade'
  async execute(instruction: ExecutionInstruction) {
    // 调用交易所 API
  }
}

// 4. 实现 Account（账户查询）
class HyperliquidAccount implements IAccount {
  readonly name: string
  readonly accountType = 'hyperliquid'
  constructor(private data: Record<string, unknown>) {
    this.name = data.name as string
  }
  async balance() { /* ... */ }
  async positions() { /* ... */ }
  async orders() { /* ... */ }
  async pnl() { /* ... */ }
  async history() { /* ... */ }
}

// 5. 组装运行时
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
  accounts: ['HL Main'],           // Credential name，对应 accountTypes[0]
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

## 适合谁用

**最适合**：
- 策略开发者：需要插件化、可扩展的策略框架
- AI 应用开发者：想把 LLM 推理嵌入交易策略，策略逻辑可复用
- 基础设施开发者：需要可替换任意层的交易引擎底座

**不适合**：
- 非技术交易者（需要编程能力）
- 只需要简单网格/指标策略的用户（用 Chainstack Bot 更快）
- 需要开箱即用 Web UI 的用户（UI 规划中）

---

## 当前状态

核心引擎已完成，包括四层架构、触发系统、LLM 推理、热加载、持久化存储、Account 账户查询接口、参数系统（base + tunable）。

规划中：回测系统、内置量化因子库、Web UI、官方交易所适配器。

---

## 许可证

开发中，许可证待定。