# OpenWhale 框架设计文档 — 11 Skill

---

## 一、定位

Skill 是给 **Compiler** 看的能力描述文档，**不参与 Runtime 执行**。

核心作用：在编译阶段告知 AI 有哪些 Executor 可用、每个 Executor 能接受什么格式的 `ExecutionInstruction`，让 AI 生成的 Strategy 代码输出正确的指令格式。

**Skill 解决的问题：**

Strategy 代码只输出 `ExecutionInstruction`，不直接调用任何外部服务。但 AI 在生成代码时需要知道"我能输出什么指令、格式是什么"——这就是 Skill 的职责。

---

## 二、Skill 数据结构

```typescript
interface Skill {
  name: string              // 唯一标识，如 'hyperliquid'
  description: string       // 给 AI 看：这个服务/能力是什么
  actions: SkillAction[]    // 给 AI 看：可以输出哪些 ExecutionInstruction
}

interface SkillAction {
  action: string            // 指令名，如 'hl.market_order'
  description: string       // 给 AI 看：这个指令做什么
  params: SkillParam[]      // 给 AI 看：参数说明
  example?: object          // 给 AI 看：完整示例
}

interface SkillParam {
  name: string
  type: string              // 'string' | 'number' | 'boolean' | ...
  required: boolean
  description: string
}
```

---

## 三、Skill 示例

### HyperliquidSkill

```typescript
const HyperliquidSkill: Skill = {
  name: 'hyperliquid',
  description: 'Hyperliquid 永续合约交易所，支持市价单、限价单、平仓、撤单',
  actions: [
    {
      action: 'hl.market_order',
      description: '以市价开仓，立即成交',
      params: [
        { name: 'coin',     type: 'string',  required: true,  description: '交易币种，如 BTC、ETH' },
        { name: 'isBuy',    type: 'boolean', required: true,  description: 'true = 做多，false = 做空' },
        { name: 'size',     type: 'number',  required: true,  description: '开仓数量（USD 计价）' },
        { name: 'slippageBps', type: 'number', required: false, description: '滑点容忍度（基点），默认 50' },
      ],
      example: { action: 'hl.market_order', params: { coin: 'BTC', isBuy: false, size: 100, slippageBps: 50 } }
    },
    {
      action: 'hl.limit_order',
      description: '挂限价单',
      params: [
        { name: 'coin',  type: 'string',  required: true,  description: '交易币种' },
        { name: 'isBuy', type: 'boolean', required: true,  description: 'true = 买，false = 卖' },
        { name: 'size',  type: 'number',  required: true,  description: '数量（USD）' },
        { name: 'price', type: 'number',  required: true,  description: '限价价格' },
        { name: 'tif',   type: 'string',  required: false, description: 'Gtc | Ioc | Alo，默认 Gtc' },
      ],
      example: { action: 'hl.limit_order', params: { coin: 'BTC', isBuy: true, size: 100, price: 90000 } }
    },
    {
      action: 'hl.close_position',
      description: '平掉指定币种的全部仓位',
      params: [
        { name: 'coin',  type: 'string',  required: true, description: '要平仓的币种' },
        { name: 'isBuy', type: 'boolean', required: true, description: '当前持仓方向（平多传 false，平空传 true）' },
        { name: 'size',  type: 'number',  required: true, description: '平仓数量' },
      ],
      example: { action: 'hl.close_position', params: { coin: 'BTC', isBuy: true, size: 100 } }
    },
    {
      action: 'hl.cancel_order',
      description: '撤销挂单',
      params: [
        { name: 'coin',    type: 'string', required: true, description: '币种' },
        { name: 'orderId', type: 'number', required: true, description: '订单 ID' },
      ],
      example: { action: 'hl.cancel_order', params: { coin: 'BTC', orderId: 12345 } }
    }
  ]
}
```

### UniswapSkill

```typescript
const UniswapSkill: Skill = {
  name: 'uniswap',
  description: 'Uniswap V3 去中心化交易所，支持代币兑换',
  actions: [
    {
      action: 'uniswap.swap',
      description: '在 Uniswap V3 上兑换代币',
      params: [
        { name: 'tokenIn',   type: 'string', required: true,  description: '输入代币地址或符号' },
        { name: 'tokenOut',  type: 'string', required: true,  description: '输出代币地址或符号' },
        { name: 'amountIn',  type: 'string', required: true,  description: '输入数量（wei 字符串）' },
        { name: 'slippage',  type: 'number', required: false, description: '最大滑点百分比，默认 0.5' },
      ],
      example: { action: 'uniswap.swap', params: { tokenIn: 'WETH', tokenOut: 'USDC', amountIn: '1000000000000000000', slippage: 0.5 } }
    }
  ]
}
```

---

## 四、Skill 在 Compiler 中的使用

Compiler 在 Phase 0 分析阶段，将所有已注册 Skill 的描述注入 Prompt：

```
已注册的 Executor 能力（Skill）：

[hyperliquid] Hyperliquid 永续合约交易所，支持市价单、限价单、平仓、撤单
  - hl.market_order: 以市价开仓
    params: coin(string), isBuy(boolean), size(number), slippageBps?(number)
    example: { action: 'hl.market_order', params: { coin: 'BTC', isBuy: false, size: 100 } }
  - hl.limit_order: 挂限价单
    ...

[uniswap] Uniswap V3 去中心化交易所
  - uniswap.swap: 兑换代币
    ...

Strategy 代码必须按以上格式输出 ExecutionInstruction，
使用已有 Executor 时不得自定义新的 action 格式。
```

AI 生成的 Strategy 代码会严格按照 Skill 声明的格式输出指令：

```javascript
class GeneratedStrategy extends Strategy {
  async execute(context) {
    // ...决策逻辑...

    // 按 HyperliquidSkill 声明的格式输出
    return {
      action: 'hl.market_order',
      params: { coin: 'BTC', isBuy: false, size: 100, slippageBps: 50 }
    }
  }
}
```

---

## 五、Skill 注册

```typescript
// Runtime 启动时注册
runtime.registerSkill(HyperliquidSkill)
runtime.registerSkill(UniswapSkill)

// Compiler 初始化时传入
const compiler = new StrategyCompiler({
  skills: runtime.getSkills()
})
```

---

## 六、自定义 Executor 时的 Skill

当 Compiler 需要编译自定义 Executor 时，会同时生成对应的 Skill 描述，并在编译 Strategy 时注入，确保两者格式一致。

```
编译自定义 Executor
  → 生成 Executor 代码（定义能处理哪些 action）
  → 同时生成对应的 Skill 描述
  → 编译 Strategy 时注入该 Skill
  → Strategy 输出格式与 Executor 自动对齐
```
