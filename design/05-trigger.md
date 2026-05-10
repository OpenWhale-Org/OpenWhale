# OpenWhale 框架设计文档 — 05 Trigger

---

## 一、定位

Trigger 是策略的触发机制，决定 Strategy 何时被执行。

**关键设计原则：**
- Trigger 在 Strategy 类里定义，不在 StrategyInstance 里配置
- Trigger 的动态值（监听哪个 coin、过滤阈值等）从 `params` 读取
- 同一个 Strategy 类的不同 Instance 通过不同 `params` 实现不同触发行为

---

## 二、Trigger 数据结构

```typescript
interface Trigger {
  id: string                                    // 框架在 activate() 时自动生成
  strategyInstanceId: string                    // 框架在 activate() 时自动填入
  enabled: boolean
  conditions: [TriggerCondition, ...TriggerCondition[]]
  window?: number                               // ms，多条件 AND 的时间窗口
}

// 定时条件
interface CronCondition {
  type: 'cron'
  expression: string    // 标准 5 字段 cron 表达式，如 "0 */8 * * *"
}

// Monitor 订阅条件
interface MonitorCondition {
  type: 'monitor'
  sources: [MonitorSource, ...MonitorSource[]]
}

interface MonitorSource {
  monitorName: string
  key: string | '*'     // '*' 匹配该 Monitor 的所有 key
  filter?: TriggerFilter
}

interface TriggerFilter {
  field: string
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  value: unknown
}
```

---

## 三、在 Strategy 类中定义 Trigger

Strategy 类通过 `triggers(params)` 方法声明触发条件，动态值从 `params` 读取：

```typescript
class FundingRateStrategy extends BaseStrategy {
  readonly strategyId = 'funding-rate'
  readonly monitors = ['funding-rate']

  readonly baseParamsSchema = z.object({
    coin: z.string(),
    threshold: z.number().positive(),
  })

  readonly tunableParamsSchema = z.object({
    maWindow: z.number().int().min(3).max(50).default(14),
  })

  // Trigger 在类里定义，动态值从 params 读取
  triggers(params: { base: Record<string, unknown>; tunable: Record<string, unknown> }) {
    return [{
      enabled: true,
      conditions: [{
        type: 'monitor' as const,
        sources: [{
          monitorName: 'funding-rate',
          key: params.base.coin as string,
          filter: { field: 'rate', op: 'gt' as const, value: params.base.threshold }
        }]
      }]
    }]
  }

  async evaluate(context: StrategyContext) { ... }
}
```

**基类默认实现：**

```typescript
// BaseStrategy 默认返回空数组，子类按需 override
triggers(_params: { base: Record<string, unknown>; tunable: Record<string, unknown> }): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
  return []
}
```

---

## 四、activate() 时的 Trigger 生成

`Runtime.activate(instance)` 时，框架调用 `strategy.triggers(parsedParams)` 并补全 `id` 和 `strategyInstanceId`：

```typescript
const triggers = strategy.triggers(parsedParams).map((t, i) => ({
  ...t,
  id: `${instance.id}-${i}`,
  strategyInstanceId: instance.id,
}))
```

生成的 Trigger 传给 TriggerManager，不存入 StrategyInstance（StrategyInstance 只存 `params`）。

---

## 五、多条件 AND（window）

一个 Trigger 可以有多个条件，所有条件在 `window` 时间内都满足才触发：

```typescript
// 资金费率超阈值 AND 每天 8 点
triggers(params) {
  return [{
    enabled: true,
    window: 60 * 60 * 1000,   // 1 小时窗口
    conditions: [
      {
        type: 'cron',
        expression: '0 8 * * *'
      },
      {
        type: 'monitor',
        sources: [{
          monitorName: 'funding-rate',
          key: params.base.coin as string,
          filter: { field: 'rate', op: 'gt' as const, value: params.base.threshold }
        }]
      }
    ]
  }]
}
```

`window = undefined` 表示无过期：条件满足状态永久保留，直到 Trigger 触发或进程重启。

---

## 六、TriggerManager

```
TriggerManager.start()
  ├─ injectDependencies()     注入 CredentialStore、Store、HttpClient、Account、Params
  ├─ initTriggerStates()      为每个 enabled Trigger 初始化状态机
  ├─ setupMonitorHandlers()   为每个 Monitor 设置 emitHandler
  ├─ subscribeMonitors()      按 MonitorCondition 订阅对应 Monitor key
  └─ scheduleCronConditions() 注册所有 CronCondition 的 cron job
```

触发流程：

```
Monitor.emit(key, data)
  → TriggerManager.onMonitorEmit()
  → 遍历所有 Instance 的 Trigger
  → 匹配 MonitorSource（monitorName + key + filter）
  → 更新 TriggerState
  → checkAndFire()：所有条件在 window 内满足 → strategy.run(context)
```

---

## 七、StrategyInstance 与 Trigger 的关系

```typescript
// StrategyInstance 不存 triggers，只存 params
interface StrategyInstance {
  id: string
  name: string
  strategyId: string
  accounts?: string[]
  params?: {
    base: Record<string, unknown>
    tunable: Record<string, unknown>
  }
  enabled: boolean
  createdAt: string
  updatedAt: string
}
```

Trigger 是运行时产物，由 `strategy.triggers(params)` 动态生成，存在 TriggerManager 内存中，不持久化。
