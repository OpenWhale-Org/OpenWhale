# OpenWhale 框架设计文档 — 12 Executor

---

## 一、定位

Executor 是 OpenWhale 的执行单元，负责消费 Strategy 输出的 `ExecutionInstruction`，并实际执行。

**与 Monitor 的对称性：**

| 维度 | Monitor | Executor |
|------|---------|----------|
| 独立运行 | ✓ | ✓ |
| 可被 Compiler 编译 | ✓ | ✓ |
| 抽象实现 | 通过 Adapter 查询数据 | 通过 Adapter 执行操作 |
| 具体实现 | 直接接入第三方服务 | 直接接入第三方服务 |
| 数据持久化 | JSONL（采集数据） | JSONL（执行记录） |
| 扩展方式 | 多 Monitor 并行采集 | 消息队列 + 多实例消费 |

---

## 二、核心约束

**格式契约：** Executor 必须能解析 Strategy 输出的 `ExecutionInstruction` 格式。使用已有 Executor 时，Strategy 必须按该 Executor 声明的格式输出（由 Skill 在编译阶段保证）。

**职责边界：** Executor 只负责执行，不做决策。收到指令后按格式路由到对应的执行逻辑，记录结果。

---

## 三、ExecutionInstruction 格式

开放格式，由 Skill 声明、Strategy 输出、Executor 解析：

```typescript
interface ExecutionInstruction {
  action: string              // 指令名，如 'hl.market_order'、'uniswap.swap'
  params: Record<string, any> // 指令参数，格式由对应 Skill 定义
}

interface ExecutionResult {
  instruction: ExecutionInstruction
  status: 'success' | 'failed' | 'skipped'
  data?: Record<string, any>  // 执行结果数据，如成交价、txHash 等
  error?: string
  executedAt: Date
}
```

---

## 四、BaseExecutor 接口

```typescript
interface ExecutorOptions {
  dataDir?: string    // 执行记录存储目录，默认 ~/.openwhale/executions
}

abstract class BaseExecutor {
  abstract readonly executorName: string

  // 声明能处理哪些 action（与 Skill.actions 对应）
  // Compiler 用此判断是否需要编译新 Executor
  abstract readonly supportedActions: string[]

  constructor(protected options: ExecutorOptions = {}) {}

  // ==================== 执行 ====================

  // 执行单条指令（子类实现）
  abstract execute(instruction: ExecutionInstruction): Promise<ExecutionResult>

  // 批量执行（默认串行，子类可覆盖为并行）
  async executeBatch(instructions: ExecutionInstruction[]): Promise<ExecutionResult[]>

  // ==================== 独立运行（消息队列消费）====================

  // 启动消费循环
  async run(queue: ExecutionQueue): Promise<void>
  async stop(): Promise<void>

  // ==================== 数据持久化 ====================

  // 追加执行记录到 JSONL 文件
  protected record(result: ExecutionResult): void

  // ==================== 生命周期钩子 ====================

  protected async onBeforeExecute(instruction: ExecutionInstruction): Promise<void>
  protected async onAfterExecute(instruction: ExecutionInstruction, result: ExecutionResult): Promise<void>
}
```

---

## 五、消息队列

Strategy 输出的 `ExecutionInstruction` 推入消息队列，Executor 实例消费：

```typescript
interface ExecutionQueue {
  // Strategy 侧：推入指令
  push(instruction: ExecutionInstruction): Promise<void>
  pushBatch(instructions: ExecutionInstruction[]): Promise<void>

  // Executor 侧：消费指令
  consume(handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void>
  stop(): Promise<void>
}
```

**队列实现：**
- 轻量场景：本地内存队列（单进程）
- 扩展场景：Redis Stream（多实例消费，崩溃恢复）

队列实现对 Strategy 和 Executor 透明，通过 Runtime 配置切换。

**多实例扩展：**

```
Strategy → 消息队列 → Executor 实例 1
                    → Executor 实例 2
                    → Executor 实例 N
```

多个 Executor 实例消费同一队列，实现并行执行和负载均衡。

---

## 六、抽象 Executor vs 具体 Executor

**抽象 Executor（通过 Adapter 实现）：**

```typescript
class PerpTradingExecutor extends BaseExecutor {
  readonly executorName = 'PerpTradingExecutor'
  readonly supportedActions = ['perp.market_order', 'perp.limit_order', 'perp.close_position']

  constructor(private adapter: PerpExchangeAdapter) {
    super()
  }

  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult> {
    switch (instruction.action) {
      case 'perp.market_order':
        return this.adapter.placeOrder({ type: 'market', ...instruction.params })
      case 'perp.close_position':
        return this.adapter.closePosition(instruction.params)
      // ...
    }
  }
}

// 同一个 Executor，对接不同交易所
const binanceExecutor = new PerpTradingExecutor(new BinanceAdapter(...))
const hlExecutor      = new PerpTradingExecutor(new HyperliquidAdapter(...))
```

**具体 Executor（直接接入服务）：**

```typescript
class HyperliquidExecutor extends BaseExecutor {
  readonly executorName = 'HyperliquidExecutor'
  readonly supportedActions = ['hl.market_order', 'hl.limit_order', 'hl.close_position', 'hl.cancel_order']

  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult> {
    // 直接调用 Hyperliquid SDK，不经过 Adapter
  }
}
```

---

## 七、Executor 独立运行

Executor 可以脱离 Runtime 独立运行，直接消费消息队列：

```typescript
const executor = new HyperliquidExecutor({ ... })
const queue = new RedisExecutionQueue({ ... })

// 独立启动，持续消费
await executor.run(queue)
```

---

## 八、Compiler 编译 Executor

当策略需要自定义执行逻辑时，Compiler 生成 Executor 代码：

```
策略描述中包含非标准执行需求
  → Compiler 分析：没有现成 Executor 能处理
  → 编译自定义 Executor 代码
  → 同时生成对应 Skill 描述
  → 编译 Strategy 时注入该 Skill，确保格式对齐
```

生成的 Executor 代码同样继承 `BaseExecutor`，遵循相同的接口规范。

---

## 九、执行记录

每条指令的执行结果追加到 JSONL 文件：

```
~/.openwhale/executions/{executorName}/{date}.jsonl
```

```jsonl
{"ts":1746028800000,"action":"hl.market_order","params":{"coin":"BTC","isBuy":false,"size":100},"status":"success","data":{"filledSize":100,"avgPrice":95000,"orderId":"12345"},"executedAt":"2026-04-30T08:00:00Z"}
{"ts":1746028801000,"action":"hl.market_order","params":{"coin":"ETH","isBuy":false,"size":50},"status":"failed","error":"Insufficient margin","executedAt":"2026-04-30T08:00:01Z"}
```
