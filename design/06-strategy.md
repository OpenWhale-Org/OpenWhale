# OpenWhale 框架设计文档 — 06 Strategy

---

## 一、定位

Strategy 是 OpenWhale 的决策单元。

**关键特点：**
- 由 Compiler 根据策略描述自动生成代码
- 继承 `Strategy` 基类，使用 `rule()` + `llm()` 混合执行模式
- 规则引擎优先（快速、确定性、零 LLM 成本），LLM 按需调用
- **只负责决策，不负责执行**：输出 `ExecutionInstruction[]`，由 Executor 实际执行
- 可读取 Monitor 历史数据和 Credentials，不直接调用任何外部服务

---

## 二、Strategy 基类

```typescript
interface StepOptions {
  cache?: boolean       // 是否缓存结果，默认 true
  timeout?: number      // 超时时间（ms），默认 30000
}

interface LLMOptions {
  prompt: string
  model?: string        // 模型 ID，默认使用 Runtime 配置的执行模型
  temperature?: number  // 默认 0.7
  parser?: 'text' | 'json' | 'number'
  reasoning?: 'minimal' | 'low' | 'medium' | 'high'
}

class Strategy {
  protected context: StrategyContext

  // ==================== 核心执行原语 ====================

  // 执行步骤（带缓存）
  async step<T>(name: string, fn: () => Promise<T>, options?: StepOptions): Promise<T>

  // 规则引擎（同步、确定性，不消耗 LLM）
  async rule<T>(name: string, fn: () => T): Promise<T>

  // LLM 调用（异步，消耗 token）
  async llm(name: string, options: LLMOptions): Promise<any>

  // ==================== 流程控制 ====================

  // 并行执行多个步骤
  async parallel<T>(steps: (() => Promise<T>)[]): Promise<T[]>

  // 遍历集合（串行）
  async forEach<T, R>(collection: T[], fn: (item: T) => Promise<R>): Promise<R[]>

  // 条件分支
  async when<T>(
    condition: boolean | (() => boolean),
    thenFn: () => Promise<T>,
    elseFn?: () => Promise<T>
  ): Promise<T | null>

  // ==================== 资源访问 ====================

  // 访问 Credentials（解密后的明文）
  async credential(name: string): Promise<string>

  // 读取 Monitor 历史数据
  monitorData<T>(monitorName: string, key: string): MonitorDataReader<T>

  // ==================== 指标收集 ====================

  getMetrics(): StrategyMetrics
}
```

---

## 三、ExecutionInstruction 格式

Strategy 的输出是开放格式的指令，由 Skill 在编译阶段定义：

```typescript
interface ExecutionInstruction {
  action: string              // 指令名，如 'hl.market_order'、'uniswap.swap'
  params: Record<string, any> // 指令参数，格式由对应 Skill 定义
}
```

**使用已有 Executor 时**，Strategy 必须严格按照该 Executor 对应 Skill 声明的格式输出，Compiler 在编译时通过注入 Skill 描述来保证这一点。

---

## 四、AI 生成的 Strategy 代码规范

1. 类名必须为 `GeneratedStrategy`，继承 `Strategy`
2. 必须实现 `async execute(context)` 方法
3. 返回值为 `ExecutionInstruction[]`、单个 `ExecutionInstruction`，或 `null`（不执行）
4. 优先使用 `rule()` 处理确定性逻辑，只在需要复杂判断时使用 `llm()`
5. 使用可选链（`?.`）防御性访问 context 属性
6. 纯 JavaScript，不含 TypeScript 类型注解
7. **不得直接调用任何外部服务**，所有外部操作通过 `ExecutionInstruction` 表达

---

## 五、Strategy 代码示例

### 示例 1：资金费率套利策略

```javascript
class GeneratedStrategy extends Strategy {
  async execute(context) {
    const history = this.monitorData('FundingRateMonitor', context.coin).readLast(3)

    // rule: 判断是否连续 3 次为正且超过阈值
    const shouldShort = await this.rule('check-funding', () => {
      if (history.length < 3) return false
      return history.every(d => d.rate > 0.0001)
    })

    if (!shouldShort) return null

    // rule: 计算仓位大小
    const size = await this.rule('calc-size', () => {
      return Math.min(context.balance * 0.1, 1000)
    })

    // 输出执行指令（格式由 HyperliquidSkill 定义）
    return {
      action: 'hl.market_order',
      params: { coin: context.coin, isBuy: false, size, slippageBps: 50 }
    }
  }
}
```

### 示例 2：含 LLM 推理的趋势策略

```javascript
class GeneratedStrategy extends Strategy {
  async execute(context) {
    const prices = this.monitorData('PriceMonitor', 'BTC-USDT').readLast(48)

    // rule: 快速技术指标计算
    const trend = await this.rule('calc-trend', () => {
      const ma7  = prices.slice(-7).reduce((s, d) => s + d.price, 0) / 7
      const ma24 = prices.slice(-24).reduce((s, d) => s + d.price, 0) / 24
      return { ma7, ma24, bullish: ma7 > ma24 }
    })

    // 只在趋势不明朗时调用 LLM
    if (Math.abs(trend.ma7 - trend.ma24) / trend.ma24 < 0.005) {
      const decision = await this.llm('trend-analysis', {
        prompt: `MA7=${trend.ma7.toFixed(2)}, MA24=${trend.ma24.toFixed(2)}, 最新价=${context.price}，判断趋势方向`,
        parser: 'json',
        reasoning: 'low'
      })
      if (decision.action === 'skip') return null
      return {
        action: 'hl.market_order',
        params: { coin: 'BTC', isBuy: decision.bullish, size: context.balance * 0.05 }
      }
    }

    return {
      action: 'hl.market_order',
      params: { coin: 'BTC', isBuy: trend.bullish, size: context.balance * 0.05 }
    }
  }
}
```

### 示例 3：并行多币种扫描，输出多条指令

```javascript
class GeneratedStrategy extends Strategy {
  async execute(context) {
    const coins = ['BTC', 'ETH', 'SOL', 'ARB']

    // 并行读取所有币种的最新资金费率
    const rates = await this.parallel(
      coins.map(coin => async () => {
        const latest = this.monitorData('FundingRateMonitor', coin).readLatest()
        return { coin, rate: latest?.rate ?? 0 }
      })
    )

    // rule: 找出所有满足条件的币种
    const targets = await this.rule('filter-targets', () => {
      return rates.filter(r => r.rate > 0.0001)
    })

    if (targets.length === 0) return null

    // 对每个目标输出一条执行指令
    return targets.map(t => ({
      action: 'hl.market_order',
      params: { coin: t.coin, isBuy: false, size: context.balance * 0.05 }
    }))
  }
}
```

---

## 六、StrategyContext

```typescript
interface StrategyContext {
  // 触发信息
  triggerType: 'cron' | 'subscribe'
  triggerData?: any       // SubscribeTrigger 触发时的 Monitor 数据
  triggerTime: Date

  // 运行时注入（由 Runtime 填充）
  credentials: CredentialStore
  monitorDataDir: string

  // 用户自定义上下文（来自 StrategyBundle.defaultContext）
  [key: string]: any
}
```

---

## 七、执行指标

```typescript
interface StrategyMetrics {
  steps: StepMetric[]
  ruleExecutions: number
  llmCalls: number
  totalTime: number
  totalCost: number       // LLM 调用总成本（USD）
  totalTokens: number
  ruleRatio: number       // rule 占总步骤的比例（越高越好）
}
```

**黄金比例目标：** rule:llm = 50:50，尽量用规则引擎替代 LLM 调用，降低成本、提升速度。
