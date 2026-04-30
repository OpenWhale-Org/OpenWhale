# OpenWhale

> 以自然语言驱动、AI 编译执行、持续自进化的经济活动自动化框架

OpenWhale 面向金融场景（交易、DeFi、预测市场等），提供两层能力：

- **策略引擎（Core）**：用自然语言描述策略 → AI 编译成可执行代码 → Runtime 自动运行 → Optimizer 持续优化，形成「描述 → 编译 → 运行 → 优化 → 再编译」的闭环。可作为独立 SDK 使用。
- **个人助理（Assistant）**：基于策略引擎之上的对话交互层，用户用自然语言管理策略、查询持仓、接收主动推送。

---

## 架构

```
┌──────────────────────────────────────────────────────┐
│                    用户（终端用户）                     │
└──────────────┬───────────────────────┬────────────────┘
               │ 自然语言对话           │ 直接调用（开发者）
               ▼                       │
┌──────────────────────────┐           │
│    Assistant 个人助理     │           │
│  对话 / Session / 记忆    │           │
│  主动推送 / 工具调用       │           │
└──────────────┬───────────┘           │
               │                       │
               ▼                       ▼
┌──────────────────────────────────────────────────────┐
│              策略引擎（OpenWhale Core）                │
│                                                        │
│  Compiler → Runtime → Optimizer                        │
│  Monitor / Trigger / Strategy / Executor               │
└──────────────────────────────────────────────────────┘
```

---

## Packages

| Package | 说明 |
|---------|------|
| `@openwhale/core` | 策略引擎核心，包含 Monitor、Executor、Trigger、Strategy、Runtime 等全部模块 |
| `@openwhale/assistant` | 个人助理层，Session 管理、LLM 对话、工具调用（Phase 2） |
| `@openwhale/mcp-server` | 将策略引擎暴露为 MCP Server，任意 MCP 客户端均可驱动（Phase 2） |

---

## 快速开始

### 环境要求

- Node.js >= 20
- pnpm >= 8

### 安装

```bash
pnpm install
```

### 构建

```bash
pnpm build
```

### 类型检查

```bash
pnpm typecheck
```

---

## 核心概念

### Monitor

数据采集器，负责从外部数据源（交易所、链上、预言机等）采集数据并持久化为 JSONL。

支持两种运行模式（`MonitorMode`）：

- `Subscribe`：由外部 key 驱动，每个 key 独立采集（如 REST 轮询）
- `Standalone`：Monitor 自行管理连接，全局启动一次（如 WebSocket）

```typescript
import { BaseMonitor, MonitorMode } from '@openwhale/core'

class PriceMonitor extends BaseMonitor<string, { price: number }> {
  readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'price' }

  protected startSubscribe(key: string) {
    // 启动针对 key 的数据采集
  }
  protected stopSubscribe(key: string) {
    // 停止采集，释放资源
  }
}
```

### Strategy

策略基类，定义触发后的决策逻辑，输出 `ExecutionInstruction[]`，不直接调用外部接口。

```typescript
import { Strategy } from '@openwhale/core'

class MyStrategy extends Strategy {
  readonly strategyId = 'my-strategy'

  async evaluate(context) {
    const data = await this.monitorData('price')?.readLatest()
    return this.rule(data?.data.price > 50000, [
      { action: 'place_order', params: { side: 'buy', size: 0.1 } }
    ])
  }
}
```

### Executor

执行器基类，消费 `ExecutionQueue` 中的指令并执行，结果自动记录为 JSONL。

```typescript
import { BaseExecutor } from '@openwhale/core'

class TradeExecutor extends BaseExecutor {
  get executorName() { return 'trade' }
  get supportedActions() { return ['place_order', 'cancel_order'] }

  async execute(instruction) {
    // 调用交易所 API 执行指令
  }
}
```

### ExecutionQueue

指令队列接口，内置 `MemoryExecutionQueue`（默认）和 `RedisExecutionQueue`（骨架）。

```typescript
import { OpenWhaleRuntime, MemoryExecutionQueue } from '@openwhale/core'

const runtime = new OpenWhaleRuntime({ queue: new MemoryExecutionQueue() })
```

---

## 设计文档

详细设计见 [`design/`](./design/) 目录：

- [CONCEPTS.md](./design/CONCEPTS.md) — 框架全貌（无代码版）
- [01-overview.md](./design/01-overview.md) — 整体架构
- [03-monitor.md](./design/03-monitor.md) — Monitor 模块
- [06-strategy.md](./design/06-strategy.md) — Strategy 模块
- [09-runtime.md](./design/09-runtime.md) — Runtime 模块
- [12-executor.md](./design/12-executor.md) — Executor 模块
- [13-assistant.md](./design/13-assistant.md) — Assistant 模块

---

## License

MIT
