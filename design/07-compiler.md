# OpenWhale 框架设计文档 — 07 Compiler

---

## 一、定位

Compiler 将用户的自然语言策略描述编译成可执行的 `StrategyBundle`。

**核心能力：**
- 三阶段编译（Phase 0: 分析，Phase 1: 编译+验证，Phase 2: 回测验证）
- 编译失败自动修复（Fixer Agent）
- 回测不通过自动重编译（Recompiler Agent）
- 编译缓存（hash 索引，避免重复编译）

---

## 二、编译流程

```
策略描述（自然语言）
       │
       ▼
┌─────────────────────────────────────────────────────┐
│  Phase 0: 分析（Analyzer Agent）                     │
│                                                       │
│  输入：策略描述 + 已注册 Skill 列表                    │
│  输出：StrategyAnalysis                               │
│    - 需要哪些 Monitor（已有 / 需要自定义）              │
│    - 需要哪些 Executor（已有 / 需要自定义）             │
│    - 使用哪些已有 Skill（注入 Strategy 编译 Prompt）    │
│    - Trigger 类型（cron / subscribe）及配置            │
│    - 策略的核心逻辑摘要                                │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│  Phase 1: 编译（Compiler Agent + Fixer Agent）        │
│                                                       │
│  Step 1: 编译自定义 Monitor（如需要）                  │
│  Step 2: 编译自定义 Executor（如需要）                 │
│          → 同时生成对应 Skill 描述                     │
│  Step 3: 生成 Trigger 配置                            │
│  Step 4: 编译 Strategy 代码                           │
│          → 注入所有相关 Skill（已有 + 新生成）          │
│          → AI 按 Skill 格式输出 ExecutionInstruction  │
│                                                       │
│  验证循环（最多 maxRetries 次）：                       │
│    → 静态验证（语法 + 结构检查）                        │
│    → Mock 数据 dry-run（不实际执行，检查运行时错误）     │
│    → 失败 → Fixer Agent 修复 → 重新验证                │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────┐
│  Phase 2: 回测验证（Judge Agent + Recompiler Agent）  │
│                                                       │
│  对比：直接 LLM 决策 vs 工作流（Strategy 代码）决策     │
│  相似度 >= backtestThreshold（默认 85%）→ 通过         │
│  不通过 → Recompiler Agent 根据反馈重新编译            │
│  最多重试 maxBacktestRetries 次                        │
└──────────────────────────┬──────────────────────────┘
                           │
                           ▼
                    StrategyBundle
```

---

## 三、Phase 0：Skill 注入

Phase 0 分析阶段，Compiler 将所有已注册 Skill 的描述注入 Prompt，让 AI 了解可用的执行能力：

```
已注册的 Executor 能力（Skill）：

[hyperliquid] Hyperliquid 永续合约交易所，支持市价单、限价单、平仓、撤单
  - hl.market_order: 以市价开仓，立即成交
    params: coin(string, required), isBuy(boolean, required), size(number, required), slippageBps?(number)
    example: { action: 'hl.market_order', params: { coin: 'BTC', isBuy: false, size: 100 } }
  - hl.limit_order: 挂限价单
    params: coin(string), isBuy(boolean), size(number), price(number), tif?(string)
    example: { action: 'hl.limit_order', params: { coin: 'BTC', isBuy: true, size: 100, price: 90000 } }
  - hl.close_position: 平掉指定币种的全部仓位
    ...
  - hl.cancel_order: 撤销挂单
    ...

[uniswap] Uniswap V3 去中心化交易所，支持代币兑换
  - uniswap.swap: 在 Uniswap V3 上兑换代币
    params: tokenIn(string), tokenOut(string), amountIn(string), slippage?(number)
    ...

Strategy 代码必须按以上格式输出 ExecutionInstruction。
使用已有 Executor 时不得自定义新的 action 格式。
```

Analyzer Agent 根据策略描述和 Skill 列表，判断：
- 使用哪些已有 Skill（直接注入 Strategy 编译 Prompt）
- 是否需要自定义 Executor（若无现成 Skill 能满足需求）

---

## 四、Phase 1：编译自定义 Executor

当策略需要自定义执行逻辑时，Compiler 在编译 Strategy 之前先编译 Executor：

```
策略描述中包含非标准执行需求
  → Analyzer 判断：没有现成 Skill 能处理
  → Compiler Agent 编译自定义 Executor 代码
  → 同时生成对应 Skill 描述（定义新的 action 格式）
  → 将新 Skill 注入 Strategy 编译 Prompt
  → Strategy 代码按新 Skill 格式输出 ExecutionInstruction
  → 两者格式自动对齐
```

编译顺序：
1. 自定义 Monitor（如需要）
2. 自定义 Executor（如需要）→ 同时生成 Skill
3. Trigger 配置
4. Strategy 代码（注入所有 Skill）

---

## 五、StrategyBundle（编译产物）

```typescript
interface StrategyBundle {
  id: string
  description: string               // 原始策略描述

  // 编译产物
  monitorCode?: string              // 自定义 Monitor 代码（可选）
  executorCode?: string             // 自定义 Executor 代码（可选）
  triggerConfig: Trigger            // Trigger 配置
  strategyCode: string              // Strategy 代码（GeneratedStrategy 类）

  // 依赖声明
  requiredAdapters: AdapterType[]   // 需要的 Adapter 类型
  requiredSkills: string[]          // 使用的 Skill 名称（已有 + 新生成）
  requiredCredentials: string[]     // 需要的 Credential 名称（启动前检查）

  // 运行配置
  defaultContext?: Record<string, any>  // 注入 StrategyContext 的默认值
  allowConcurrent?: boolean             // 是否允许并发执行，默认 false

  // 元数据
  compiledAt: Date
  backtestScore: number             // 回测相似度分数（0-1）
  compilationStats: CompilationStats
}
```

---

## 六、StrategyCompiler 接口

```typescript
interface CompilerOptions {
  // 模型配置
  analyzerModel?: string    // Phase 0 分析模型，默认 claude-opus-4
  compilerModel?: string    // Phase 1 编译模型，默认 claude-opus-4
  executorModel?: string    // Phase 2 执行模型（工作流运行），默认 deepseek-chat
  directModel?: string      // Phase 2 直接 LLM 对比模型，默认 claude-opus-4

  // 编译参数
  maxRetries?: number           // Phase 1 最大重试次数，默认 5
  enableBacktest?: boolean      // 是否启用 Phase 2，默认 true
  backtestThreshold?: number    // 回测相似度阈值，默认 0.85
  maxBacktestRetries?: number   // Phase 2 最大重试次数，默认 5

  // 已注册 Skill（Phase 0 注入 Prompt）
  skills?: Skill[]

  // 缓存
  useCache?: boolean            // 是否使用编译缓存，默认 true
  cacheDir?: string

  // 回测数据
  backtestDataProvider?: BacktestDataProvider

  // 日志
  enableLogging?: boolean
  logDir?: string
}

class StrategyCompiler {
  constructor(options?: CompilerOptions) {}

  // 编译策略描述为 StrategyBundle
  async compile(
    description: string,
    testContext?: TestContext,
    forceRecompile?: boolean
  ): Promise<StrategyBundle>

  // 仅验证代码（不编译）
  async validate(code: string): Promise<{ valid: boolean; error?: string }>

  // 获取编译统计
  getCompilationStats(): CompilationStats | null
}
```

---

## 七、各 Agent 的职责

| Agent | 模型 | 推理级别 | 职责 |
|-------|------|---------|------|
| Analyzer | claude-opus-4 | medium | 分析策略描述，确定所需 Monitor/Executor/Skill，输出 StrategyAnalysis |
| Compiler | claude-opus-4 | medium | 编译 Monitor、Executor、Strategy 代码 |
| Fixer | claude-opus-4 | high | 根据错误信息修复代码 |
| DirectLLM | claude-opus-4 | — | Phase 2 中作为"直接 LLM"基准 |
| Judge | claude-opus-4 | low | 判断两个决策的一致性（输出相似度分数） |
| Recompiler | claude-opus-4 | high | 根据回测反馈重新编译 |

工作流执行模型（Strategy 代码运行）使用 deepseek-chat，成本低、速度快。

---

## 八、编译缓存

缓存 key = `sha256(strategyDescription)`，避免相同描述重复编译：

```
~/.openwhale/cache/
  {hash}.json    // 包含完整 StrategyBundle
```

`forceRecompile = true` 时跳过缓存。

---

## 九、Strategy 代码生成规范（Compiler Prompt 约束）

```
1. 类名必须为 GeneratedStrategy，继承 Strategy
2. 必须实现 async execute(context) 方法
3. 优先使用 rule() 处理确定性逻辑（目标：50% rule + 50% llm）
4. 使用可选链防御性访问 context 属性
5. 返回 ExecutionInstruction[]、单个 ExecutionInstruction，或 null
6. 纯 JavaScript，不含 TypeScript 类型注解
7. 不得直接调用任何外部服务，所有外部操作通过 ExecutionInstruction 表达
8. ExecutionInstruction 格式必须严格遵循注入的 Skill 声明
```

---

## 十、回测验证逻辑

Phase 2 的核心是验证工作流代码与直接 LLM 的决策一致性：

```
对每个测试场景：
  1. 直接 LLM：将策略描述 + 测试数据发给 LLM，获取决策
  2. 工作流：用测试数据运行 Strategy 代码，获取决策
  3. Judge Agent：对比两个决策，输出相似度分数（0-1）

平均相似度 >= backtestThreshold → 通过
否则 → Recompiler Agent 分析差异，重新生成代码
```

相似度计算维度：
- 决策方向（buy/sell/hold）是否一致（权重最高）
- 置信度差异
- 其他自定义字段的一致性
