# OpenWhale 框架设计文档 — 01 概述与架构

> 更新日期：2026-04-30

---

## 一、框架定位

OpenWhale 是一个**以自然语言驱动、AI 编译执行、持续自进化的经济活动自动化框架**。

面向金融场景（交易、DeFi、预测市场等），提供两层能力：
- **策略引擎（Core）**：用自然语言描述策略 → AI 编译成可执行代码 → Runtime 自动运行 → Optimizer 持续优化，形成「描述 → 编译 → 运行 → 优化 → 再编译」的闭环
- **个人助理（Assistant）**：基于策略引擎之上的对话交互层，用户可以用自然语言管理策略、查询持仓、接收主动推送，是金融场景的 AI 助理

两层相互独立：策略引擎可作为纯 SDK 使用，Assistant 是面向终端用户的可选上层。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         用户（终端用户）                               │
└──────────────┬──────────────────────────────┬───────────────────────┘
               │ 自然语言对话                   │ 直接调用（开发者）
               ▼                               │
┌──────────────────────────────┐               │
│       Assistant 个人助理      │               │
│                               │               │
│  对话 Agent（Vercel AI SDK）  │               │
│  Session 管理 / 长期记忆       │               │
│  主动推送通知                  │               │
│                               │               │
│  工具调用 ↓                   │               │
└──────────────┬────────────────┘               │
               │                                │
               ▼                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    策略引擎（OpenWhale Core）                          │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      Compiler 编译器                          │   │
│  │  Phase 0: 分析 → Phase 1: 编译+验证 → Phase 2: 回测验证        │   │
│  │  输出：StrategyBundle                                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                               │                                       │
│                               ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                       Runtime 运行时                           │   │
│  │                                                                │   │
│  │  Monitor → Trigger → Strategy → 消息队列 → Executor            │   │
│  │     ↑                                           │              │   │
│  │  Adapter                                     Adapter           │   │
│  │  第三方服务                                  第三方服务          │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                               │ 真实运行数据                           │
│                               ▼                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                      Optimizer 优化器                          │   │
│  │  参数优化 / 策略代码调整，均经回测验证后更新 StrategyBundle        │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  所有持久化数据以 JSONL 格式存储于本地文件系统                          │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、模块列表

**策略引擎（Core）：**

| 模块 | 文件 | 职责 |
|------|------|------|
| Credentials | `02-credentials.md` | 敏感信息加密存储 |
| Monitor | `03-monitor.md` | 数据采集与持久化 |
| Adapter | `04-adapter.md` | 第三方服务抽象接口（供 Monitor 和 Executor 使用） |
| Trigger | `05-trigger.md` | 策略触发机制 |
| Strategy | `06-strategy.md` | AI 生成的决策单元，输出 ExecutionInstruction |
| Compiler | `07-compiler.md` | 策略描述 → StrategyBundle |
| Optimizer | `08-optimizer.md` | 策略自进化 |
| Runtime | `09-runtime.md` | 运行时调度与消息队列 |
| Storage | `10-storage.md` | 存储方案总览 |
| Skill | `11-skill.md` | 给 Compiler 看的能力描述，定义可用的指令格式 |
| Executor | `12-executor.md` | 执行 ExecutionInstruction，可多实例扩展 |

**个人助理层：**

| 模块 | 文件 | 职责 |
|------|------|------|
| Assistant | `13-assistant.md` | 对话交互、Session 管理、长期记忆、主动推送 |

---

## 四、Monitor 与 Executor 的对称性

Monitor 和 Executor 是框架的两端，设计完全对称：

| 维度 | Monitor | Executor |
|------|---------|----------|
| 独立运行 | ✓ | ✓ |
| 可被 Compiler 编译 | ✓（自定义数据采集） | ✓（自定义执行逻辑） |
| 抽象实现 | 通过 Adapter 查询数据 | 通过 Adapter 执行操作 |
| 具体实现 | 直接接入第三方服务 | 直接接入第三方服务 |
| 数据持久化 | JSONL（采集数据） | JSONL（执行记录） |
| 扩展方式 | 多 Monitor 并行采集 | 消息队列 + 多实例消费 |

---

## 五、Skill 的定位

Skill 是给 **Compiler** 看的能力描述文档，不参与 Runtime 执行。

- 描述某个 Executor 能接受哪些 `ExecutionInstruction` 格式
- Compiler 将 Skill 注入 Prompt，AI 生成 Strategy 代码时按此格式输出指令
- Strategy 代码与 Executor 之间的格式契约，由 Skill 在编译阶段建立

---

## 六、核心数据流示例

```
用户描述：
  "当 BTC 资金费率连续 3 次为正且超过 0.01% 时，在 Hyperliquid 做空 BTC，止损 5%"

Compiler 分析：
  - Monitor: FundingRateMonitor（通过 PerpExchangeAdapter 采集）
  - Executor: HyperliquidExecutor（已有，注入 Skill 描述）
  - Trigger: subscribe(FundingRateMonitor, 'BTC')
  - Strategy: 读取最近 3 条数据 → rule 判断 → 输出指令

Runtime 运行：
  FundingRateMonitor 每 8 小时采集一次
    → 数据追加到 ~/.openwhale/monitor-data/FundingRateMonitor/BTC.jsonl
    → emit('BTC', data)
    → TriggerManager 触发 Strategy 执行
    → rule: 检查最近 3 条是否满足条件
    → 满足 → 输出 { action: 'hl.market_order', params: { coin: 'BTC', isBuy: false, size: 100 } }
    → 推入消息队列
    → HyperliquidExecutor 消费，实际下单

Optimizer（定期触发）：
  读取执行历史 → AI 分析止损 5% 是否合理
  → 尝试 [3%, 5%, 8%, 10%] 四个参数回测
  → 选出最优 → 更新 StrategyBundle
```
