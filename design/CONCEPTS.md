# OpenWhale 框架设计文档（概念版）

> 本文档为无代码的纯设计版本，适合快速理解框架全貌。
> 详细接口定义与代码规范请参阅 `01-overview.md` 起的各模块文档。

---

## 一、框架定位

OpenWhale 是一个**以自然语言驱动、AI 编译执行、持续自进化的经济活动自动化框架**。

面向金融场景（交易、DeFi、预测市场等），提供两层能力：

**策略引擎（Core）：** 用自然语言描述策略 → AI 编译成可执行代码 → Runtime 自动运行 → Optimizer 持续优化，形成「描述 → 编译 → 运行 → 优化 → 再编译」的闭环。可作为独立 SDK 使用。

**个人助理（Assistant）：** 基于策略引擎之上的对话交互层，用户用自然语言管理策略、查询持仓、接收主动推送。是金融场景的 AI 助理，策略引擎不依赖它。

---

## 二、整体架构

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

## 三、模块概览

**策略引擎（Core）：**

| 模块 | 职责 | 详细文档 |
|------|------|---------|
| Credentials | 敏感信息加密存储 | `02-credentials.md` |
| Monitor | 数据采集与持久化 | `03-monitor.md` |
| Adapter | 第三方服务抽象接口 | `04-adapter.md` |
| Trigger | 策略触发机制 | `05-trigger.md` |
| Strategy | AI 生成的决策单元 | `06-strategy.md` |
| Compiler | 策略描述 → StrategyBundle | `07-compiler.md` |
| Optimizer | 策略自进化 | `08-optimizer.md` |
| Runtime | 运行时调度与消息队列 | `09-runtime.md` |
| Storage | 存储方案总览 | `10-storage.md` |
| Skill | Compiler 侧能力描述 | `11-skill.md` |
| Executor | 执行 ExecutionInstruction | `12-executor.md` |

**个人助理层：**

| 模块 | 职责 | 详细文档 |
|------|------|---------|
| Assistant | 对话交互、Session 管理、长期记忆、主动推送 | `13-assistant.md` |

---

## 四、Credentials（凭证管理）

**职责：** 安全存储私钥、API Key 等敏感信息，供 Monitor 和 Executor 在初始化 Adapter 时使用。

**设计要点：**
- 本地加密文件存储，AES-256-GCM 加密，密钥来自环境变量
- 按名称检索，支持增删改查
- Strategy 代码可通过 `this.credential(name)` 读取解密后的明文
- 不在日志或错误信息中暴露明文值

---

## 五、Monitor（数据监控）

**职责：** 定期或持续采集外部数据，持久化为 JSONL，并在数据更新时 emit 事件供 Trigger 订阅。

**设计要点：**
- 泛型设计：`BaseMonitor<TKey, TData>`，Key 是采集维度（如币种），Data 是采集内容
- 订阅引用计数（refCount）：同一 Key 被多个 Trigger 订阅时只运行一个采集循环，全部取消订阅后自动停止
- 数据以 JSONL 格式追加存储，每个 Key 一个文件
- 提供 `MonitorDataReader`，支持读取最近 N 条、时间范围查询、流式读取
- 可独立运行（脱离 Runtime），也可被 Compiler 编译生成自定义采集逻辑

**两种实现方式：**
- 抽象 Monitor：通过 Adapter 查询数据，可对接多个交易所
- 具体 Monitor：直接调用特定服务 SDK，无需 Adapter

---

## 六、Adapter（服务适配器）

**职责：** 对高频、通用的第三方服务类型提供统一抽象接口，同时服务于 Monitor（数据查询）和 Executor（操作执行）。

**设计要点：**
- 不强求全部抽象，只覆盖高频通用类型
- 同一 Adapter 实例可被 Monitor 和 Executor 共享，避免重复初始化
- Monitor 使用 Adapter 的只读方法（查询行情、资金费率等）
- Executor 使用 Adapter 的写操作方法（下单、平仓等）

**内置 Adapter 类型：**
- SpotExchangeAdapter：现货交易所（行情查询、账户、下单）
- PerpExchangeAdapter：永续合约交易所（继承现货，新增资金费率、持仓、杠杆）
- NFTMarketplaceAdapter：NFT 市场（地板价、挂单、购买）
- PredictionMarketAdapter：预测市场（市场列表、赔率、下注）
- BridgeAdapter：跨链桥（报价、跨链、状态查询）
- BlockchainAdapter：链上操作（余额查询、合约调用、发送交易）

---

## 七、Trigger（触发器）

**职责：** 决定 Strategy 何时执行，支持定时触发和事件驱动触发两种模式。

**两种触发类型：**

- **CronTrigger**：按 cron 表达式定时触发，适合周期性策略（如每小时检查一次）
- **SubscribeTrigger**：订阅 Monitor 的数据更新事件，数据满足过滤条件时触发，适合事件驱动策略

**过滤器（TriggerFilter）：** SubscribeTrigger 可配置简单的字段比较条件，只有满足条件的数据才触发 Strategy 执行，避免无效触发。

**并发控制：** TriggerManager 维护正在运行的 Strategy 集合，默认不允许同一 Strategy 并发执行（可配置）。

---

## 八、Strategy（策略）

**职责：** 框架的决策单元，由 Compiler 根据策略描述自动生成，**只负责决策，不负责执行**。

**核心设计：**
- 继承 `Strategy` 基类，实现 `execute(context)` 方法
- 输出 `ExecutionInstruction[]`（执行指令），由 Executor 实际执行
- 不直接调用任何外部服务，所有外部操作通过指令表达
- 可读取 Monitor 历史数据和 Credentials

**执行模式：**
- `rule()`：规则引擎，同步、确定性、零 LLM 成本，优先使用
- `llm()`：LLM 调用，用于复杂判断，按需使用
- 目标比例：rule:llm = 50:50，尽量用规则替代 LLM 调用

**流程控制原语：** 支持并行执行（parallel）、集合遍历（forEach）、条件分支（when）、带缓存的步骤（step）。

**ExecutionInstruction 格式：** 开放格式 `{ action: string, params: Record<string, any> }`，格式由 Skill 在编译阶段定义，Strategy 严格遵循。

---

## 九、Skill（能力描述）

**职责：** 给 Compiler 看的能力描述文档，**不参与 Runtime 执行**。

**核心作用：** 在编译阶段告知 AI 有哪些 Executor 可用、每个 Executor 能接受什么格式的 ExecutionInstruction，让 AI 生成的 Strategy 代码输出正确的指令格式。

**内容结构：**
- Skill 名称与描述（这个服务/能力是什么）
- 可输出的 ExecutionInstruction 列表，每条包含：指令名、描述、参数说明、示例

**使用方式：**
- Runtime 启动时注册 Skill 描述
- Compiler 初始化时获取所有已注册 Skill
- Phase 0 分析时，将 Skill 描述注入 Prompt，AI 了解可用的执行能力
- Phase 1 编译 Strategy 时，注入相关 Skill，AI 按此格式输出指令

**自定义 Executor 时：** Compiler 编译自定义 Executor 代码的同时，自动生成对应 Skill 描述，并在编译 Strategy 时注入，确保两者格式自动对齐。

---

## 十、Executor（执行器）

**职责：** 消费 Strategy 输出的 ExecutionInstruction，实际执行操作，记录执行结果。

**与 Monitor 的对称性：**

| 维度 | Monitor | Executor |
|------|---------|----------|
| 独立运行 | ✓ | ✓ |
| 可被 Compiler 编译 | ✓ | ✓ |
| 抽象实现 | 通过 Adapter 查询数据 | 通过 Adapter 执行操作 |
| 具体实现 | 直接接入第三方服务 | 直接接入第三方服务 |
| 数据持久化 | JSONL（采集数据） | JSONL（执行记录） |
| 扩展方式 | 多 Monitor 并行采集 | 消息队列 + 多实例消费 |

**格式契约：** Executor 声明自己能处理哪些 action（`supportedActions`），Strategy 必须按此格式输出指令，由 Skill 在编译阶段建立契约。

**多实例扩展：** 多个 Executor 实例消费同一消息队列，实现并行执行和负载均衡。

**执行记录：** 每条指令的执行结果（成功/失败、成交价、txHash 等）追加到 JSONL 文件。

---

## 十一、Compiler（编译器）

**职责：** 将自然语言策略描述编译为可执行的 StrategyBundle。

**三阶段编译流程：**

**Phase 0 — 分析（Analyzer Agent）**
- 输入：策略描述 + 已注册 Skill 列表
- 输出：需要哪些 Monitor、哪些 Executor、使用哪些 Skill、Trigger 类型与配置
- 判断是否需要自定义编译 Monitor 或 Executor

**Phase 1 — 编译（Compiler Agent + Fixer Agent）**
- 按顺序编译：自定义 Monitor → 自定义 Executor（同时生成 Skill）→ Trigger 配置 → Strategy 代码
- 编译 Strategy 时注入所有相关 Skill，AI 按 Skill 格式输出 ExecutionInstruction
- 验证循环：静态语法检查 → Mock 数据 dry-run → 失败则 Fixer Agent 修复

**Phase 2 — 回测验证（Judge Agent + Recompiler Agent）**
- 对比直接 LLM 决策 vs Strategy 代码决策，相似度 ≥ 85% 通过
- 不通过则 Recompiler Agent 根据差异反馈重新编译

**编译产物 StrategyBundle：** 包含 Monitor 代码（可选）、Executor 代码（可选）、Trigger 配置、Strategy 代码、依赖声明、运行配置、回测分数。

**编译缓存：** 相同策略描述（hash 相同）直接返回缓存结果，避免重复编译。

---

## 十二、Runtime（运行时）

**职责：** 管理所有组件的生命周期，调度 Strategy 执行，通过消息队列连接 Strategy 与 Executor。

**核心组件：**
- CredentialStore：敏感信息管理
- AdapterRegistry：Adapter 实例注册表（Monitor 和 Executor 共享）
- SkillRegistry：Skill 描述注册表（供 Compiler 使用）
- MonitorRegistry：Monitor 实例注册表
- ExecutorRegistry：Executor 实例注册表
- ExecutionQueue：消息队列（Strategy → Executor）
- TriggerManager：Trigger 注册与调度
- StrategyRunner：Strategy 执行引擎

**消息队列：** 解耦 Strategy 与 Executor，Strategy 将指令推入队列后即返回，Executor 异步消费。默认使用内存队列（单进程），可切换为 Redis Stream（多实例）。

**StrategyRunner：** 在受限 VM 沙箱中实例化并运行 Strategy 代码，将输出的 ExecutionInstruction 推入消息队列，不直接执行。

**启动流程：** 注册 Adapter → 注册 Skill → 注册 Monitor → 注册 Executor → 激活 StrategyBundle → start()（启动所有 Monitor 采集循环和 Executor 消费循环）。

---

## 十三、Optimizer（优化器）

**职责：** 定期分析策略运行数据，自动优化策略参数或代码，形成自进化闭环。

**两种优化模式：**

- **参数优化：** 对策略中的数值参数（止损比例、仓位大小、阈值等）进行调优。AI 生成候选参数组合，每组经回测验证，选出最优参数更新 StrategyBundle。

- **策略调整：** 当参数优化效果有限时，AI 分析运行数据中的模式，对策略逻辑本身提出修改建议，经回测验证后更新代码。

**优化目标：** 用户定义优化指标（如最大化收益、最小化回撤、提升胜率），Optimizer 以此为目标函数进行搜索。

**安全机制：** 所有优化结果必须经过回测验证，相似度或性能指标达标后才更新 StrategyBundle，不直接修改正在运行的策略。

---

## 十四、Storage（存储）

所有持久化数据存储于本地文件系统，格式统一为 JSONL（追加写入，不修改历史记录）：

```
~/.openwhale/
  credentials.enc.json          加密凭证
  monitor-data/
    {MonitorName}/{key}.jsonl   Monitor 采集数据
  executions/
    {ExecutorName}/{date}.jsonl Executor 执行记录
  runs/
    {bundleId}.jsonl            Strategy 运行统计
  cache/
    {hash}.json                 编译缓存（StrategyBundle）
  optimizer/
    {bundleId}/history.jsonl    优化历史
```

**设计原则：** 追加写入、不修改历史、按时间自然分片、无需数据库依赖。

Assistant 层额外存储：
```
~/.openwhale/
  sessions/
    {sessionId}.jsonl             对话历史
  memory/
    {userId}.json                 长期记忆
```

---

## 十五、Assistant（个人助理）

**职责：** OpenWhale 的用户交互层，金融场景的 AI 个人助理。策略引擎不依赖它，可作为独立上层模块使用。

**与策略引擎的关系：** Assistant 通过工具调用驱动策略引擎，而不是包含策略引擎逻辑。用户说"帮我编译一个 BTC 套利策略"，Assistant 调用 `compile_strategy()` 工具，策略引擎完成编译后返回结果。

**核心能力：**

- **对话交互**：用自然语言描述策略、查询持仓、分析执行结果、讨论优化方向
- **Session 管理**：持久化对话历史，支持跨会话上下文延续；历史过长时自动压缩，保留关键决策摘要
- **长期记忆**：独立于 Session，跨会话记住用户偏好（风险偏好、常用币种）、历史策略摘要、重要背景信息
- **主动推送**：订阅策略引擎事件，在策略触发、执行异常、优化完成时主动通知用户

**可调用的工具：** compile_strategy、activate_bundle、deactivate_bundle、get_execution_history、get_positions、query_monitor_data、list_bundles、trigger_optimizer

---

## 十六、技术选型

**LLM 调用层：Vercel AI SDK**

OpenWhale 作为开源框架，需要支持用户自选模型（Claude、GPT-4o、Gemini、Deepseek 等任意提供商）。Vercel AI SDK 提供统一的多提供商 API，切换模型只需改一行配置，是 TypeScript 生态目前最主流的选择（14k+ stars，周下载量 200 万+）。

各场景对应 API：
- Strategy `llm()` 单次调用 → `generateText`
- Strategy `llm({ parser: 'json' })` 结构化输出 → `generateObject`
- Compiler / Optimizer 多轮对话 → `generateText` + 手动维护 messages 数组
- Assistant 流式对话 → `streamText`
- Assistant 工具调用循环 → `tool()` + `maxSteps`

**存储：** 本地 JSONL 文件，无数据库依赖，轻量易部署。

**Strategy 沙箱：** Node.js `vm` 模块，限制可访问的全局对象，不暴露 fs、process、require 等危险 API。

---

## 十七、核心数据流示例

**策略引擎数据流：**

```
用户描述：
  "当 BTC 资金费率连续 3 次为正且超过 0.01% 时，在 Hyperliquid 做空 BTC"

Compiler 分析：
  Monitor  → FundingRateMonitor（通过 PerpExchangeAdapter 采集）
  Executor → HyperliquidExecutor（已有，注入 HyperliquidSkill）
  Trigger  → subscribe(FundingRateMonitor, 'BTC')
  Strategy → 读取最近 3 条数据 → rule 判断 → 输出指令

Runtime 运行：
  FundingRateMonitor 每 8 小时采集一次
    → 数据追加到 monitor-data/FundingRateMonitor/BTC.jsonl
    → emit('BTC', data)
    → TriggerManager 触发 Strategy 执行
    → rule: 检查最近 3 条是否满足条件
    → 满足 → 输出 { action: 'hl.market_order', params: { coin: 'BTC', isBuy: false, size: 100 } }
    → 推入 ExecutionQueue
    → HyperliquidExecutor 消费，实际下单
    → 执行结果追加到 executions/HyperliquidExecutor/{date}.jsonl

Optimizer（定期触发）：
  读取执行历史 → AI 分析止损参数是否合理
    → 尝试多组参数回测 → 选出最优 → 更新 StrategyBundle
```

**Assistant 数据流：**

```
用户：帮我做一个 BTC 资金费率套利策略，当连续 3 次为正超过 0.01% 时做空

Assistant：
  → 调用 compile_strategy("当 BTC 资金费率连续 3 次为正...")
  → Compiler 编译，返回 bundleId + backtestScore
  → 调用 activate_bundle(bundleId)
  → 回复用户："策略已编译并激活，回测相似度 92%，正在监控中"

（8 小时后，策略触发）

Runtime → Assistant 推送通知：
  "BTC 资金费率满足条件（连续 3 次 > 0.01%），已在 Hyperliquid 做空 100 USD"

用户：最近的执行情况怎么样？

Assistant：
  → 调用 get_execution_history(bundleId, limit=10)
  → 整理数据，回复用户执行摘要
```
