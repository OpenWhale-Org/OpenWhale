# OpenWhale 框架设计文档 — 08 Optimizer

---

## 一、定位

Optimizer 是 OpenWhale 的自进化引擎，利用真实运行数据自动改进策略。

两种优化模式：
1. **参数优化**：在固定策略逻辑下，AI 调整可配置参数，通过回测找到最优值
2. **策略调整**：AI 分析运行数据，直接修改 Strategy 代码逻辑，通过回测验证

---

## 二、优化目标

```typescript
interface OptimizationGoal {
  type:
    | 'max_return'       // 最高收益率
    | 'max_volume'       // 最高交易量
    | 'max_points'       // 最高积分（适用于积分激励场景）
    | 'min_drawdown'     // 最小回撤
    | 'max_sharpe'       // 最高夏普比率
    | 'custom'           // 自定义指标

  // type = 'custom' 时，用自然语言描述优化目标
  customDescription?: string

  // 优化时间窗口（回测使用的历史数据范围）
  lookbackDays?: number  // 默认 30 天
}
```

---

## 三、模式一：参数优化

### 流程

```
定义优化目标 + 可优化参数列表
       │
       ▼
Optimizer Agent 分析参数含义
  → 理解每个参数对策略的影响
  → 生成候选参数组合（网格搜索 or 贝叶斯优化）
       │
       ▼
对每个候选参数组合：
  → 将参数注入 Strategy 代码（替换默认值）
  → 运行历史回测
  → 计算优化目标指标
       │
       ▼
选出最优参数组合
  → 更新 StrategyBundle.defaultContext
  → 记录优化历史
```

### 可优化参数定义

```typescript
interface OptimizableParam {
  name: string                    // 参数名（对应 context 中的字段名）
  description: string             // 参数含义（AI 需要理解）
  type: 'number' | 'boolean' | 'enum'
  current: any                    // 当前值

  // number 类型
  range?: [number, number]        // 取值范围
  step?: number                   // 步长

  // enum 类型
  options?: any[]                 // 候选值列表
}
```

### 示例

```typescript
// 策略：资金费率套利，止损和仓位大小可优化
const params: OptimizableParam[] = [
  {
    name: 'stopLossPercent',
    description: '止损百分比，触发时平仓，防止亏损扩大',
    type: 'number',
    current: 5,
    range: [2, 15],
    step: 1
  },
  {
    name: 'positionSizePercent',
    description: '每次开仓占总资金的百分比',
    type: 'number',
    current: 10,
    range: [5, 30],
    step: 5
  },
  {
    name: 'minFundingRate',
    description: '触发开仓的最低资金费率阈值',
    type: 'number',
    current: 0.0001,
    range: [0.00005, 0.0005],
    step: 0.00005
  }
]

const result = await optimizer.optimizeParams(bundle, goal, params, historicalData)
// result.bestParams = { stopLossPercent: 8, positionSizePercent: 15, minFundingRate: 0.00015 }
// result.improvement = { return: '+23%', sharpe: '+0.4' }
```

---

## 四、模式二：策略调整

### 流程

```
真实运行数据（执行记录 + 盈亏统计）
+ Monitor 历史数据（触发时的市场状态）
       │
       ▼
Optimizer Agent 分析
  → 哪些情况下策略表现差？
  → 是否有系统性的误判模式？
  → 建议如何修改策略逻辑？
       │
       ▼
生成修改方案（自然语言描述）
       │
       ▼
调用 Compiler 重新编译（带修改建议）
  → Phase 1: 编译新代码
  → Phase 2: 回测验证
       │
       ▼
通过 → 更新 StrategyBundle
不通过 → 继续迭代（最多 maxIterations 次）
```

### 运行记录结构

```typescript
interface RunRecord {
  bundleId: string
  triggeredAt: Date
  triggerData?: any           // 触发时的 Monitor 数据
  executionInstructions: ExecutionInstruction[]
  executionResults: ExecutionResult[]
  metrics: StrategyMetrics
  pnl?: number                // 本次执行的盈亏（如可计算）
}

interface ExecutionResult {
  instruction: ExecutionInstruction
  status: 'success' | 'failed' | 'skipped'
  filledSize?: number
  avgPrice?: number
  error?: string
  executedAt: Date
}
```

---

## 五、Optimizer 接口

```typescript
interface OptimizerOptions {
  optimizerModel?: string       // 分析模型，默认 claude-opus-4
  maxIterations?: number        // 策略调整最大迭代次数，默认 3
  backtestDataProvider?: BacktestDataProvider
}

class Optimizer {
  constructor(
    private readonly compiler: StrategyCompiler,
    private readonly options?: OptimizerOptions
  ) {}

  // 参数优化
  async optimizeParams(
    bundle: StrategyBundle,
    goal: OptimizationGoal,
    params: OptimizableParam[],
    historicalData: TestContext[]
  ): Promise<ParamOptimizationResult>

  // 策略调整
  async optimizeStrategy(
    bundle: StrategyBundle,
    goal: OptimizationGoal,
    runHistory: RunRecord[],
    monitorHistory: Record<string, any[]>  // monitorName → 历史数据
  ): Promise<StrategyOptimizationResult>
}

interface ParamOptimizationResult {
  originalBundle: StrategyBundle
  optimizedBundle: StrategyBundle
  bestParams: Record<string, any>
  backtestResults: BacktestResult[]
  improvement: Record<string, string>  // 指标改善情况
}

interface StrategyOptimizationResult {
  originalBundle: StrategyBundle
  optimizedBundle: StrategyBundle
  analysisReport: string        // AI 的分析报告
  changes: string               // 修改了什么
  backtestScore: number
}
```

---

## 六、优化历史记录

每次优化结果追加到 JSONL 文件：

```
~/.openwhale/optimizer/{bundleId}.jsonl
```

```jsonl
{"ts":1746000000000,"type":"params","goal":"max_return","bestParams":{...},"improvement":{...}}
{"ts":1746100000000,"type":"strategy","goal":"max_return","changes":"增加了趋势过滤条件","backtestScore":0.91}
```
