# OpenWhale 框架设计文档 — 05 Trigger

---

## 一、定位

Trigger 是策略的触发机制，决定 Strategy 何时被执行。

两种触发模式：
1. **定时触发（Cron）**：按固定时间间隔执行，如每小时、每天 9 点
2. **订阅触发（Subscribe）**：监听 Monitor 的数据事件，满足条件时触发

---

## 二、Trigger 数据结构

```typescript
// 定时触发
interface CronTrigger {
  id: string
  type: 'cron'
  cron: string          // 标准 5 字段 cron 表达式，如 "0 */8 * * *"
  strategyBundleId: string
  enabled: boolean
}

// 订阅触发
interface SubscribeTrigger {
  id: string
  type: 'subscribe'
  monitorName: string   // 监听哪个 Monitor
  key: string           // 监听该 Monitor 的哪个 key
  strategyBundleId: string
  enabled: boolean
  // 可选：过滤条件（在 Monitor 事件数据上执行，返回 true 才触发）
  // 由 Compiler 从策略描述中提取，编译为简单表达式
  filter?: TriggerFilter
}

type Trigger = CronTrigger | SubscribeTrigger

// 过滤条件（简单表达式，避免任意代码执行）
interface TriggerFilter {
  // 示例：{ field: 'rate', op: 'gt', value: 0.0001 }
  field: string
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  value: any
}
```

---

## 三、TriggerManager

```typescript
class TriggerManager {
  constructor(
    private readonly monitors: Map<string, BaseMonitor>,
    private readonly strategyRunner: StrategyRunner
  ) {}

  // 注册 Trigger
  register(trigger: Trigger): void

  // 注销 Trigger
  unregister(triggerId: string): void

  // 启动（注册所有 cron，订阅所有 Monitor）
  async start(): Promise<void>

  // 停止
  async stop(): Promise<void>

  // 内部：Monitor emit → 匹配 SubscribeTrigger → 调度 Strategy
  private onMonitorEvent(monitorName: string, key: string, data: any): void

  // 内部：cron 到期 → 调度 Strategy
  private onCronFire(trigger: CronTrigger): void
}
```

**启动流程：**

```
TriggerManager.start()
  ├─ 遍历所有 SubscribeTrigger
  │    └─ monitor.setEmitHandler(onMonitorEvent)
  │    └─ monitor.subscribe(key)
  │
  └─ 遍历所有 CronTrigger
       └─ 注册 cron job（使用 node-cron 或类似库）
```

---

## 四、触发到执行的流程

```
[SubscribeTrigger]
  Monitor.emit(key, data)
    → TriggerManager.onMonitorEvent(monitorName, key, data)
    → 查找匹配的 SubscribeTrigger（monitorName + key 匹配）
    → 检查 filter（如有）
    → 满足条件 → StrategyRunner.run(bundleId, { triggerData: data })

[CronTrigger]
  cron 到期
    → TriggerManager.onCronFire(trigger)
    → StrategyRunner.run(bundleId, { triggerTime: new Date() })
```

---

## 五、Trigger 配置示例

由 Compiler 从策略描述中自动生成：

```typescript
// 策略描述："当 BTC 资金费率超过 0.01% 时执行"
// Compiler 生成的 Trigger 配置：
const trigger: SubscribeTrigger = {
  id: 'trigger_01',
  type: 'subscribe',
  monitorName: 'FundingRateMonitor',
  key: 'BTC',
  strategyBundleId: 'bundle_01',
  enabled: true,
  filter: { field: 'rate', op: 'gt', value: 0.0001 }
}

// 策略描述："每天早上 9 点执行 DCA"
// Compiler 生成的 Trigger 配置：
const trigger: CronTrigger = {
  id: 'trigger_02',
  type: 'cron',
  cron: '0 9 * * *',
  strategyBundleId: 'bundle_02',
  enabled: true
}
```

---

## 六、并发控制

同一个 Strategy 在上一次执行未完成时，默认不重复触发（防止并发执行同一策略）：

```typescript
// StrategyRunner 内部维护执行状态
private runningStrategies = new Set<string>()  // bundleId

async run(bundleId: string, context: any): Promise<void> {
  if (this.runningStrategies.has(bundleId)) {
    logger.warn(`Strategy ${bundleId} already running, skipping trigger`)
    return
  }
  this.runningStrategies.add(bundleId)
  try {
    await this.execute(bundleId, context)
  } finally {
    this.runningStrategies.delete(bundleId)
  }
}
```

可通过 `StrategyBundle.allowConcurrent = true` 关闭此限制（适用于批量并行场景）。
