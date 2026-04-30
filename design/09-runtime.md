# OpenWhale 框架设计文档 — 09 Runtime

---

## 一、定位

Runtime 是 OpenWhale 的运行时调度层，负责：
- 管理 Monitor、Trigger、Strategy、Executor 的生命周期
- 调度 Strategy 执行，将 ExecutionInstruction 推入消息队列
- 管理 Executor 实例消费消息队列并实际执行
- 收集执行统计数据

---

## 二、Runtime 架构

```
OpenWhaleRuntime
  ├── CredentialStore          敏感信息管理
  ├── AdapterRegistry          Adapter 实例注册表
  ├── SkillRegistry            Skill 描述注册表（供 Compiler 使用）
  ├── MonitorRegistry          Monitor 实例注册表
  ├── ExecutorRegistry         Executor 实例注册表
  ├── ExecutionQueue           消息队列（Strategy → Executor）
  ├── TriggerManager           Trigger 注册与调度
  ├── StrategyRunner           Strategy 执行引擎
  └── StatisticsCollector      执行统计收集
```

---

## 三、OpenWhaleRuntime 接口

```typescript
interface RuntimeConfig {
  dataDir?: string                      // 数据根目录，默认 ~/.openwhale
  encryptionKey?: string                // 加密密钥（优先于环境变量）
  executorModel?: string                // Strategy llm() 调用模型，默认 deepseek-chat
  maxConcurrentStrategies?: number      // 最大并发执行策略数，默认 10
  queue?: ExecutionQueueConfig          // 消息队列配置
}

interface ExecutionQueueConfig {
  type: 'memory' | 'redis'             // 队列实现，默认 memory
  redis?: { host: string; port: number; stream: string }
}

class OpenWhaleRuntime {
  constructor(config?: RuntimeConfig) {}

  // ==================== 注册 ====================

  registerAdapter(name: string, adapter: any): void
  registerSkill(skill: Skill): void              // 注册 Skill 描述（供 Compiler 使用）
  registerMonitor(monitor: BaseMonitor): void
  registerExecutor(executor: BaseExecutor): void // 注册 Executor 实例

  // ==================== 策略管理 ====================

  // 加载并激活一个 StrategyBundle
  async activate(bundle: StrategyBundle): Promise<void>

  // 停用一个 StrategyBundle
  async deactivate(bundleId: string): Promise<void>

  // 手动触发执行（用于测试）
  async trigger(bundleId: string, context?: Record<string, any>): Promise<void>

  // ==================== 生命周期 ====================

  async start(): Promise<void>   // 启动所有 Monitor、Executor 消费循环
  async stop(): Promise<void>    // 停止所有组件

  // ==================== 查询 ====================

  getSkills(): Skill[]           // 返回所有已注册 Skill（供 Compiler 使用）
  getRunHistory(bundleId: string, limit?: number): RunRecord[]
  getStats(bundleId: string): StrategyStats
}
```

---

## 四、消息队列

Strategy 输出的 `ExecutionInstruction` 推入消息队列，Executor 实例消费：

```
Strategy.execute()
    │
    │  ExecutionInstruction[]
    ▼
ExecutionQueue.push()
    │
    ├─ Executor 实例 1 消费
    ├─ Executor 实例 2 消费
    └─ Executor 实例 N 消费
```

**队列实现：**

```typescript
// 轻量场景：本地内存队列（单进程，默认）
const queue = new MemoryExecutionQueue()

// 扩展场景：Redis Stream（多实例消费，崩溃恢复）
const queue = new RedisExecutionQueue({
  host: 'localhost',
  port: 6379,
  stream: 'openwhale:instructions'
})
```

队列实现对 Strategy 和 Executor 透明，通过 Runtime 配置切换。

---

## 五、StrategyRunner

Strategy 执行引擎，负责实例化并运行 Strategy 代码，将结果推入消息队列：

```typescript
class StrategyRunner {
  async run(
    bundle: StrategyBundle,
    triggerContext: Partial<StrategyContext>
  ): Promise<void> {

    // 1. 构建完整 StrategyContext
    const context: StrategyContext = {
      ...bundle.defaultContext,
      ...triggerContext,
      credentials: this.credentialStore,
      monitorDataDir: this.config.dataDir,
      triggerTime: new Date()
    }

    // 2. 在沙箱中实例化并执行 Strategy 代码
    const strategy = this.instantiate(bundle.strategyCode, context)
    const result = await strategy.execute(context)

    // 3. 将 ExecutionInstruction 推入消息队列
    if (result !== null) {
      const instructions = Array.isArray(result) ? result : [result]
      await this.queue.pushBatch(instructions)
    }

    // 4. 记录 Strategy 执行统计
    await this.statistics.record({
      bundleId: bundle.id,
      triggeredAt: context.triggerTime,
      triggerData: triggerContext.triggerData,
      instructionCount: Array.isArray(result) ? result.length : (result ? 1 : 0),
      metrics: strategy.getMetrics()
    })
  }

  // 在受限 VM 中实例化 Strategy 代码
  private instantiate(code: string, context: StrategyContext): Strategy {
    // 使用 Node.js vm 模块，限制可访问的全局对象
    // 不暴露 fs、process、require 等危险 API
    const sandbox = {
      Strategy: StrategyBase,
      console: safeConsole,
    }
    vm.createContext(sandbox)
    vm.runInContext(code, sandbox)
    return new sandbox.GeneratedStrategy(context)
  }
}
```

---

## 六、执行流程（完整）

```
Trigger 触发
    │
    ▼
TriggerManager.onEvent(monitorName, key, data)
    │
    ├─ 检查 filter（如有）
    ├─ 检查 Strategy 是否已在运行（并发控制）
    │
    ▼
StrategyRunner.run(bundle, { triggerData: data })
    │
    ├─ 构建 StrategyContext
    ├─ 实例化 GeneratedStrategy（沙箱 VM）
    ├─ strategy.execute(context)
    │    ├─ rule() → 同步计算
    │    ├─ llm()  → 调用 LLM API
    │    └─ 返回 ExecutionInstruction[]
    │
    ▼
ExecutionQueue.pushBatch(instructions)
    │
    ▼
BaseExecutor.consume()
    │
    ├─ 路由到对应执行逻辑（按 action 分发）
    ├─ 通过 Adapter 或直接调用第三方 SDK 执行
    ├─ 记录执行结果到 JSONL
    └─ 返回 ExecutionResult
```

---

## 七、Executor 注册与启动

Runtime 启动时，所有注册的 Executor 开始消费消息队列：

```typescript
// 注册 Executor
runtime.registerExecutor(new HyperliquidExecutor({ ... }))
runtime.registerExecutor(new PerpTradingExecutor(new BinanceAdapter(...)))

// 启动 Runtime（同时启动所有 Executor 的消费循环）
await runtime.start()

// 内部实现：
// for (const executor of this.executorRegistry.all()) {
//   executor.run(this.queue)  // 非阻塞，持续消费
// }
```

Executor 根据 `supportedActions` 自动过滤队列中属于自己的指令：

```typescript
// ExecutionQueue 内部路由逻辑
// 每条 instruction 只被能处理它的 Executor 消费
// 若无 Executor 能处理，记录警告并跳过
```

---

## 八、统计数据

```typescript
interface StrategyStats {
  bundleId: string
  totalRuns: number
  successfulRuns: number
  failedRuns: number
  totalInstructions: number
  avgExecutionTime: number
  avgLlmCost: number
  lastRunAt?: Date
}
```

Strategy 执行统计：`~/.openwhale/runs/{bundleId}.jsonl`
Executor 执行记录：`~/.openwhale/executions/{executorName}/{date}.jsonl`

---

## 九、设计取舍

OpenWhale Runtime 优先保证**轻量、易用、可本地运行**：

- 默认使用内存消息队列，不依赖 Redis 等外部服务
- 单进程内事件驱动，所有状态存储在本地文件
- 适合个人/小团队自动化场景

如需扩展为多用户 SaaS 场景，可将：
- 内存队列 → Redis Stream（支持多 Executor 实例并行消费）
- 本地文件存储 → PostgreSQL
- 单进程调度 → 分布式 Worker
