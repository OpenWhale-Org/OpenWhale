# OpenWhale 框架设计文档 — 06 Strategy

---

## 一、定位

Strategy 是 OpenWhale 的决策单元，负责：接收触发上下文 → 决策 → 返回 `ExecutionInstruction[]`。

**关键特点：**
- 继承 `BaseStrategy`，实现 `evaluate(context)` 方法
- 声明 Trigger（`triggers(params)`）、Monitor 依赖（`monitors`）、账户类型（`accountTypes`）、参数 schema
- 只负责决策，不负责执行（输出指令，由 Executor 执行）
- 规则引擎优先，LLM 按需调用

---

## 二、Strategy 类结构

```typescript
class FundingRateStrategy extends BaseStrategy {
  // ── 身份 ──────────────────────────────────────────────────────────────────
  readonly strategyId = 'funding-rate'

  // ── 依赖声明 ──────────────────────────────────────────────────────────────
  /** 依赖的 Monitor 名称列表，框架启动时注入对应 reader */
  readonly monitors = ['funding-rate']

  /** 依赖的账户类型，按顺序对应 StrategyInstance.accounts[] */
  readonly accountTypes = ['hyperliquid'] as const
  // 或带 label：
  // readonly accountTypes = [{ type: 'hyperliquid', label: 'main' }] as const

  // ── 参数 schema ───────────────────────────────────────────────────────────
  /** 必填参数，用户手动配置 */
  readonly baseParamsSchema = z.object({
    coin: z.string(),
    maxPositionSize: z.number().positive(),
  })

  /** 可调优参数，AI Optimizer 可自动调整，带默认值 */
  readonly tunableParamsSchema = z.object({
    threshold: z.number().min(0.00001).max(0.01).default(0.0001),
    maWindow: z.number().int().min(3).max(50).default(14),
  })

  // ── Trigger 定义 ──────────────────────────────────────────────────────────
  /** 触发条件，动态值从 params 读取 */
  triggers(params: { base: Record<string, unknown>; tunable: Record<string, unknown> }) {
    return [{
      enabled: true,
      conditions: [{
        type: 'monitor' as const,
        sources: [{
          monitorName: 'funding-rate',
          key: params.base.coin as string,
          filter: { field: 'rate', op: 'gt' as const, value: params.tunable.threshold }
        }]
      }]
    }]
  }

  // ── 决策逻辑 ──────────────────────────────────────────────────────────────
  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    // 读取账户（按 index，对应 accountTypes[0] = 'hyperliquid'）
    const hl = await this.account<IHyperliquidAccount>(0)
    const balance = await hl.balance()

    // 读取 Monitor 历史数据
    const reader = this.monitorData('funding-rate')
    const recent = await reader?.readLast(this.params.base.coin, this.params.tunable.maWindow)

    if (!recent || recent.length < 3) return []

    const allAboveThreshold = recent.every(d => (d.rate as number) > this.params.tunable.threshold)
    if (!allAboveThreshold) return []

    const size = Math.min(
      balance.available * 0.1,
      this.params.base.maxPositionSize
    )

    return [{
      executorId: 'hyperliquid',
      messageId: '',
      action: 'perp.market_order',
      params: { coin: this.params.base.coin, isBuy: false, size }
    }]
  }
}
```

---

## 三、框架注入的接口（全部 protected）

| 接口 | 类型 | 说明 |
|------|------|------|
| `this.params.base` | `z.infer<typeof baseParamsSchema>` | 必填参数，类型从 schema infer |
| `this.params.tunable` | `z.infer<typeof tunableParamsSchema>` | 可调优参数，含 Zod 默认值 |
| `this.account<T>(index)` | `Promise<T>` | 按 index 访问账户，有 label 时也支持按 label |
| `this.monitorData(name)` | `MonitorDataReader \| undefined` | 读取 Monitor 历史数据 |
| `this.credential(name)` | `Promise<{ type, data }>` | 读取原始 Credential |
| `this.store` | `IStrategyStore` | Instance 级持久化 KV，跨重启保留 |
| `this.http` | `HttpClient` | 受控 HTTP 客户端，所有请求自动 log |
| `this.llm(options)` | `Promise<T \| string>` | LLM 推理，支持结构化输出（Zod schema） |

---

## 四、参数系统

### 两段式 schema

```typescript
// 必填参数：用户手动配置，框架不调优
readonly baseParamsSchema = z.object({
  coin: z.string(),
  maxPositionSize: z.number().positive(),
})

// 可调优参数：AI Optimizer 可自动调整，必须有默认值
readonly tunableParamsSchema = z.object({
  threshold: z.number().min(0.00001).max(0.01).default(0.0001),
  maWindow: z.number().int().min(3).max(50).default(14),
})
```

**基类默认提供空 schema**，子类按需 override：

```typescript
// BaseStrategy 默认
readonly baseParamsSchema = z.object({})
readonly tunableParamsSchema = z.object({})
```

### 校验时机

`Runtime.activate(instance)` 时：
1. `baseParamsSchema.parse(instance.params?.base ?? {})` — 必填字段缺失直接报错
2. `tunableParamsSchema.parse(instance.params?.tunable ?? {})` — 缺失字段用 `.default()` 补全

### 访问方式

类型从 schema infer，不需要泛型参数：

```typescript
this.params.base.coin           // string
this.params.tunable.maWindow    // number（含默认值）
```

---

## 五、账户系统

### 声明账户类型

```typescript
// 简单形式（字符串数组）
readonly accountTypes = ['hyperliquid', 'binance'] as const

// 带 label 形式（支持按 label 访问）
readonly accountTypes = [
  { type: 'hyperliquid', label: 'main' },
  { type: 'binance', label: 'hedge' },
] as const
```

### 访问账户

```typescript
// 按 index
const hl = await this.account<IPerpAccount>(0)

// 按 label（仅当声明了 label 时有效）
const hl = await this.account<IPerpAccount>('main')
```

### 校验时机

`Runtime.activate(instance)` 时：
- `instance.accounts.length === strategy.accountTypes.length`
- `instance.accounts[i]` 对应 Credential 的 `type` 必须匹配 `accountTypes[i]`

---

## 六、工作流辅助方法

| 方法 | 说明 |
|------|------|
| `this.step(key, fn)` | 单次运行内缓存，同一 key 只执行一次 |
| `this.rule(cond, instructions)` | 条件为真时返回指令，否则返回空数组 |
| `this.when(cond, then, else)` | if/else 分支 |
| `this.parallel(sets)` | 合并多组指令（flat） |
| `this.forEach(items, fn)` | 对列表每项生成指令 |

---

## 七、注入链

```
Runtime.activate(instance)
  ├─ strategyFactory() → 创建 Strategy 实例
  ├─ parseParams()     → Zod 校验并补全 params
  ├─ validateAccounts() → 校验账户类型匹配
  ├─ ensureAccounts()  → 按需创建 Account 实例存入 AccountRegistry
  └─ strategy.triggers(parsedParams) → 生成 Trigger，注册到 TriggerManager

TriggerManager.start() → injectDependencies()
  ├─ strategy.setCredentialStore(store)
  ├─ strategy.setStore(new DBStrategyStore(instanceId, db))
  ├─ strategy.setHttpClient(new HttpClient(strategyId))
  ├─ strategy.setAccounts(instanceAccounts)   ← 该 instance 的账户列表
  ├─ strategy.setParams(parsedParams)         ← 校验补全后的 params
  └─ strategy.setMonitorReader(name, reader)  ← 按 monitors[] 注入
```

---

## 八、设计边界

Strategy **只做决策**，不做副作用：
- 不直接调用交易所 API（交给 Executor）
- 不写 Monitor 数据（Monitor 自己写）
- HTTP 请求允许但必须通过 `this.http`（可观测）
- Account 只读（`balance()`、`positions()` 等查询方法，无下单操作）
