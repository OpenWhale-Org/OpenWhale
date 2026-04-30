# OpenWhale 框架设计文档 — 13 Assistant

---

## 一、定位

Assistant 是 OpenWhale 的**用户交互层**，是面向终端用户的金融场景个人助理。

**与策略引擎的关系：**
- 策略引擎（Compiler / Runtime / Optimizer）是无人值守的自动化核心，独立运行
- Assistant 是策略引擎之上的可选交互层，通过工具调用驱动策略引擎
- 策略引擎不依赖 Assistant，可以单独作为 SDK 使用
- Assistant 不包含任何策略执行逻辑，所有操作通过调用策略引擎完成

```
用户
 │
 ▼
Assistant（对话 Agent）
 ├─ 工具：compile_strategy()       → Compiler
 ├─ 工具：activate_bundle()        → Runtime
 ├─ 工具：get_positions()          → Executor 执行记录
 ├─ 工具：get_execution_history()  → 执行记录 JSONL
 ├─ 工具：query_monitor_data()     → Monitor 历史数据
 └─ 工具：trigger_optimizer()      → Optimizer
          │
          ▼
     策略引擎（OpenWhale Core）
```

---

## 二、核心能力

**对话交互：**
- 用自然语言描述策略，Assistant 调用 Compiler 编译并激活
- 查询持仓、执行历史、Monitor 数据
- 讨论策略逻辑，分析运行结果

**主动推送：**
- 策略触发时通知用户（"BTC 资金费率满足条件，已做空"）
- 执行异常告警（"ETH 下单失败：保证金不足"）
- Optimizer 优化完成通知（"止损参数已从 5% 优化至 3.2%"）

**长期记忆：**
- 记住用户偏好（风险偏好、常用币种、惯用策略模式）
- 跨会话保持上下文（上次讨论的策略、未完成的编译任务）

---

## 三、Session 管理

Assistant 需要持久化 Session，支持跨会话的上下文延续：

```typescript
interface AssistantSession {
  sessionId: string
  userId: string
  messages: AssistantMessage[]     // 完整对话历史
  createdAt: Date
  updatedAt: Date
}

interface AssistantMessage {
  role: 'user' | 'assistant' | 'tool_result'
  content: string | ContentBlock[]
  timestamp: Date
}
```

**上下文压缩：** 当对话历史超过模型上下文窗口时，自动压缩旧消息，保留：
- 最近 N 条完整消息
- 关键决策摘要（编译了哪些策略、做了哪些操作）
- 用户偏好和重要背景

Session 持久化路径：`~/.openwhale/sessions/{sessionId}.jsonl`

---

## 四、长期记忆

独立于 Session 的跨会话记忆，存储用户级别的持久信息：

```typescript
interface AssistantMemory {
  userId: string

  // 用户偏好
  preferences: {
    riskLevel?: 'conservative' | 'moderate' | 'aggressive'
    favoriteCoins?: string[]
    defaultExchange?: string
  }

  // 策略历史摘要（不存完整代码，只存关键信息）
  strategyHistory: {
    bundleId: string
    description: string
    performance?: string
    createdAt: Date
  }[]

  // 自由格式的记忆条目（由 LLM 决定何时写入）
  notes: {
    content: string
    createdAt: Date
  }[]
}
```

记忆存储路径：`~/.openwhale/memory/{userId}.json`

---

## 五、工具定义

Assistant 通过工具调用驱动策略引擎，工具格式遵循 Vercel AI SDK 的 `tool()` 定义：

**compile_strategy** — 编译策略描述为 StrategyBundle
```
输入：description(string), testContext?(object)
输出：bundleId, backtestScore, compilationStats
```

**activate_bundle** — 激活一个已编译的 StrategyBundle
```
输入：bundleId(string)
输出：status, activatedAt
```

**deactivate_bundle** — 停用策略
```
输入：bundleId(string)
输出：status
```

**get_execution_history** — 查询执行记录
```
输入：bundleId?(string), limit?(number), since?(Date)
输出：ExecutionResult[]
```

**get_positions** — 查询当前持仓（通过 Executor 执行记录推算）
```
输入：exchange?(string)
输出：Position[]
```

**query_monitor_data** — 查询 Monitor 历史数据
```
输入：monitorName(string), key(string), limit?(number)
输出：MonitorData[]
```

**list_bundles** — 列出所有已编译的策略
```
输入：status?('active' | 'inactive' | 'all')
输出：StrategyBundle[]
```

**trigger_optimizer** — 手动触发优化
```
输入：bundleId(string), goal?(OptimizationGoal)
输出：optimizationId
```

---

## 六、主动推送

Assistant 订阅策略引擎的关键事件，主动通知用户：

```typescript
interface AssistantNotification {
  type: 'execution' | 'error' | 'optimization' | 'alert'
  bundleId?: string
  title: string
  body: string
  data?: Record<string, any>
  timestamp: Date
}
```

**事件来源：**
- Runtime：Strategy 触发执行、ExecutionInstruction 推入队列
- Executor：执行成功/失败结果
- Optimizer：优化完成、参数更新
- Monitor：异常数据（可配置阈值告警）

推送方式由上层应用决定（Web UI 的 SSE、CLI 的终端输出、未来可扩展到 Telegram/Discord 等）。

---

## 七、技术选型

**LLM 调用：** Vercel AI SDK（`streamText` + `generateText`）
- 多提供商支持，用户可自选模型
- `streamText` 用于流式对话输出
- `tool()` 定义工具，`maxSteps` 控制工具调用循环

**Session 持久化：** JSONL 文件（与策略引擎存储风格一致）

**上下文压缩：** 超出窗口时调用 LLM 生成摘要，替换旧消息

**记忆写入：** LLM 在对话结束时判断是否有值得记住的信息，写入 memory 文件

---

## 八、AssistantRuntime 接口

```typescript
interface AssistantConfig {
  model?: LanguageModel          // Vercel AI SDK 模型实例，默认 claude-sonnet
  dataDir?: string               // 数据目录，默认 ~/.openwhale
  systemPrompt?: string          // 自定义系统提示词
  maxSteps?: number              // 工具调用最大步数，默认 10
  onNotification?: (n: AssistantNotification) => void  // 推送回调
}

class AssistantRuntime {
  constructor(
    private openwhale: OpenWhaleRuntime,  // 策略引擎实例
    private config?: AssistantConfig
  ) {}

  // 发送消息，返回流式响应
  async chat(
    sessionId: string,
    message: string
  ): Promise<AssistantMessageStream>

  // 获取或创建 Session
  async getSession(sessionId: string): Promise<AssistantSession>

  // 列出所有 Session
  async listSessions(): Promise<AssistantSession[]>

  // 删除 Session
  async deleteSession(sessionId: string): Promise<void>

  // 读取用户记忆
  async getMemory(userId: string): Promise<AssistantMemory>
}
```

---

## 九、与策略引擎的独立性

Assistant 是**可选模块**，策略引擎不依赖它：

```typescript
// 仅使用策略引擎（开发者 / SDK 场景）
const runtime = new OpenWhaleRuntime(config)
await runtime.activate(bundle)

// 使用完整的助理层（终端用户场景）
const runtime = new OpenWhaleRuntime(config)
const assistant = new AssistantRuntime(runtime, { model: anthropic('claude-sonnet-4-5') })
const stream = await assistant.chat(sessionId, '帮我编译一个 BTC 资金费率套利策略')
```

这种分层确保 OpenWhale Core 保持纯粹，可以作为独立 SDK 被集成到任何应用中，Assistant 是面向终端用户的上层封装。
