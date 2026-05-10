# OpenWhale 框架设计文档 — 15 Account

---

## 一、定位

Account 是 Credential 的"已激活实例"，提供账户查询能力（余额、持仓、挂单等）。

**核心设计：**
- Account 不是独立的存储系统，而是基于 Credential 构建的运行时对象
- Credential 的 `type` 字段决定能否实例化为 Account（注册了 AccountFactory 的 type 才能）
- Account 是纯查询接口，不提供下单等写操作（写操作由 Executor 负责）
- Account 实例在 Runtime 级别统一缓存（AccountRegistry），多个 StrategyInstance 共享

---

## 二、IAccount 接口

```typescript
interface IAccount {
  readonly name: string         // Credential name，如 "HL Main"
  readonly accountType: string  // 如 "hyperliquid"

  balance(): Promise<IBalance>
  positions(): Promise<IPosition[]>
  orders(): Promise<IOrder[]>
  pnl(since?: Date): Promise<IPnL>
  history(limit?: number): Promise<IHistoryRecord[]>
}
```

### 基础类型（最小公约数）

```typescript
interface IBalance {
  available: number   // 可用资金（USD 计价）
  total: number       // 总资产（USD 计价）
  currency: string    // 计价币种，如 'USDT'、'USD'
}

interface IPosition {
  id: string
  value: number       // 当前市值（USD 计价）
  pnl: number         // 未实现盈亏（USD 计价）
}

interface IOrder {
  id: string
  side: 'buy' | 'sell'
  value: number       // 挂单价值（USD 计价）
  status: 'open' | 'partial'
}

interface IPnL {
  realized: number
  unrealized: number
  currency: string
}

interface IHistoryRecord {
  id: string
  timestamp: number
  type: string        // 'trade' | 'transfer' | 'funding' | ...
  value: number       // USD 计价
}
```

### 平台扩展

各平台通过接口继承扩展特定字段：

```typescript
// 永续合约账户
interface IPerpAccount extends IAccount {
  balance(): Promise<IPerpBalance>
  positions(): Promise<IPerpPosition[]>
}

interface IPerpBalance extends IBalance {
  marginUsed: number
  marginRatio: number
}

interface IPerpPosition extends IPosition {
  coin: string
  size: number
  entryPrice: number
  leverage: number
  liquidationPrice: number
}
```

Strategy 里通过泛型 cast 访问平台特定字段：

```typescript
// 通用字段
const bal = await this.account<IAccount>(0)
bal.available   // ✓

// 平台特定字段
const hl = await this.account<IPerpAccount>(0)
const positions = await hl.positions()
positions[0].liquidationPrice   // ✓
```

---

## 三、AccountFactory 注册

框架不内置任何平台实现，通过工厂函数注册：

```typescript
// 注册 AccountFactory
runtime.registerAccountFactory(
  'hyperliquid',
  (data: Record<string, unknown>) => new HyperliquidAccount(data)
)

runtime.registerAccountFactory(
  'binance',
  (data: Record<string, unknown>) => new BinanceAccount(data)
)
```

`data` 是 Credential 解密后的 JSON 对象（如 `{ privateKey: '0x...', address: '0x...' }`）。

通过 Plugin 批量注册：

```typescript
interface OpenWhalePlugin {
  accounts: Array<{
    accountType: string
    factory: (data: Record<string, unknown>) => IAccount
  }>
}
```

---

## 四、AccountRegistry 生命周期

- **创建时机**：`Runtime.activate(instance)` 时，按需创建 `instance.accounts[]` 里的账户
- **共享**：同一 Credential name 只创建一次，多个 StrategyInstance 共享同一实例
- **销毁**：Account 实例常驻 AccountRegistry，不随 `deactivate()` 移除，Runtime 关闭时销毁

```typescript
// activate() 内部逻辑
for (const credentialName of instance.accounts ?? []) {
  if (!this.accountRegistry.has(credentialName)) {
    const { type, data } = await this.credentialStore.getByName(credentialName)
    const factory = this.accountFactories.get(type)
    if (!factory) throw new Error(`No AccountFactory registered for type: ${type}`)
    this.accountRegistry.set(credentialName, factory(data))
  }
}
```

---

## 五、在 Strategy 中使用

### 声明账户类型

```typescript
class ArbitrageStrategy extends BaseStrategy {
  // 简单形式
  readonly accountTypes = ['hyperliquid', 'binance'] as const

  // 带 label 形式（支持按 label 访问）
  readonly accountTypes = [
    { type: 'hyperliquid', label: 'main' },
    { type: 'binance', label: 'hedge' },
  ] as const
}
```

### 访问账户

```typescript
async evaluate(context: StrategyContext) {
  // 按 index
  const hl = await this.account<IPerpAccount>(0)

  // 按 label（仅当声明了 label 时有效）
  const hl = await this.account<IPerpAccount>('main')

  const balance = await hl.balance()
  const positions = await hl.positions()
}
```

### StrategyInstance 配置

`accounts[]` 按 `accountTypes` 顺序填写 Credential name：

```typescript
runtime.activate({
  id: 'inst-1',
  strategyId: 'arbitrage',
  accounts: ['HL Main', 'Binance Main'],  // index 0 = hyperliquid, index 1 = binance
  params: { base: { ... }, tunable: {} },
  enabled: true,
  // ...
})
```

---

## 六、校验规则

`Runtime.activate(instance)` 时校验：

1. `instance.accounts.length === strategy.accountTypes.length`
2. `instance.accounts[i]` 对应 Credential 的 `type` 必须匹配 `accountTypes[i]`（或 `accountTypes[i].type`）
3. 对应的 AccountFactory 必须已注册

任一校验失败直接抛错，不等到触发时才发现。

---

## 七、与 Credential 的关系

```
Credential { name: "HL Main", type: "hyperliquid", data: "加密..." }
    ↓ getByName("HL Main") → { type: "hyperliquid", data: { privateKey: "0x..." } }
    ↓ accountFactories.get("hyperliquid")(data)
Account { name: "HL Main", accountType: "hyperliquid", ... }
    ↓ 存入 AccountRegistry
    ↓ 注入给 Strategy
this.account<IPerpAccount>(0)  →  HyperliquidAccount 实例
```
