# OpenWhale 框架设计文档 — 03 Monitor

---

## 一、定位

Monitor 是 OpenWhale 的数据采集单元，负责：
- 通过第三方 API（或 Adapter）获取外部数据
- 将数据持久化到本地 JSONL 文件
- 管理数据的完整生命周期（产生、持久化、过期清理）
- 支持订阅模式（事件驱动）和直接运行模式（主动轮询）

---

## 二、设计原则

**Monitor 可以是抽象的，也可以是具体的：**

```
抽象 Monitor（通过 Adapter 实现）：
  FundingRateMonitor → PerpExchangeAdapter.getFundingRate()
  PriceMonitor       → SpotExchangeAdapter.getPrice()

具体 Monitor（直接接入服务）：
  HyperliquidLeaderMonitor → 直接调用 HL WebSocket
  TwitterSentimentMonitor  → 直接调用 Twitter API
```

**订阅模式 vs 直接运行模式：**

- **订阅模式**：Monitor 被 Trigger 订阅，数据就绪后 emit 事件，驱动 Strategy 执行
- **直接运行模式**：Monitor 独立运行，定时采集数据并持久化，不依赖订阅关系

---

## 三、BaseMonitor 接口

```typescript
interface MonitorOptions {
  dataDir?: string    // 数据存储根目录，默认 ~/.openwhale/monitor-data
  ttl?: number        // 数据过期时间（ms），undefined = 永不过期
}

abstract class BaseMonitor<TKey = string, TData = any> {
  abstract readonly monitorName: string   // 唯一标识，用于文件路径和事件路由

  constructor(protected options: MonitorOptions = {}) {}

  // ==================== 数据采集 ====================

  // 主动拉取一次数据（子类实现）
  abstract fetch(key: TKey): Promise<TData>

  // 定时轮询（内部调用 fetch → append → emit）
  async run(key: TKey, intervalMs: number): Promise<void>
  async stop(key: TKey): Promise<void>

  // ==================== 订阅模式 ====================

  // refCount per key，支持多个订阅者订阅同一 key
  async subscribe(key: TKey): Promise<void>
  async unsubscribe(key: TKey): Promise<void>

  // 注册外部 emit handler（由 TriggerManager 注册，转发事件给 Trigger）
  setEmitHandler(handler: (key: TKey, data: TData) => void | Promise<void>): void

  // 内部：数据就绪后调用，触发 emit handler
  protected async emit(key: TKey, data: TData): Promise<void>

  // ==================== 数据持久化 ====================

  // 追加一条数据到 JSONL 文件
  protected append(key: TKey, data: TData): void

  // 清理过期数据（重写 JSONL 文件，过滤掉 ts < now - ttl 的记录）
  protected prune(key: TKey): void

  // 获取该 key 的 MonitorDataReader
  getReader(key: TKey): MonitorDataReader<TData>

  // ==================== 生命周期钩子 ====================

  protected async onFirstSubscribe(key: TKey): Promise<void>  // 默认：启动轮询
  protected async onLastUnsubscribe(key: TKey): Promise<void> // 默认：停止轮询
  protected async onBeforeEmit(key: TKey, data: TData): Promise<void>
  protected async onAfterEmit(key: TKey, data: TData): Promise<void>
}
```

**订阅引用计数（refCount）：**

同一个 key 可以被多个 Trigger 订阅。Monitor 内部维护每个 key 的引用计数：
- 第一个订阅者 → `onFirstSubscribe`（启动轮询）
- 最后一个取消订阅 → `onLastUnsubscribe`（停止轮询）
- 中间的订阅/取消不影响轮询状态

---

## 四、JSONL 存储格式

每个 Monitor 的每个 key 对应一个 JSONL 文件：

```
~/.openwhale/monitor-data/
  FundingRateMonitor/
    BTC.jsonl
    ETH.jsonl
  PriceMonitor/
    BTC-USDT.jsonl
  LeaderPositionMonitor/
    0xabc123.jsonl
```

文件格式（每行一个 JSON 对象，必须包含 `ts` 字段）：

```jsonl
{"ts":1746000000000,"coin":"BTC","rate":0.0001,"nextFundingTime":1746028800000}
{"ts":1746028800000,"coin":"BTC","rate":0.00015,"nextFundingTime":1746057600000}
{"ts":1746057600000,"coin":"BTC","rate":-0.00005,"nextFundingTime":1746086400000}
```

**写入策略：** 追加写入（`fs.appendFileSync`），单进程安全，无需加锁。

**过期清理：** 当 `ttl` 设置时，每次 `append` 后检查文件头部是否有过期数据，如有则重写文件（过滤掉过期行）。

---

## 五、MonitorDataReader

辅助读取 Monitor 历史数据，供 Strategy 代码使用：

```typescript
class MonitorDataReader<TData = any> {
  constructor(private readonly filePath: string) {}

  // 读取最新 N 条
  readLast(n: number): TData[]

  // 读取时间范围内的数据
  readRange(from: Date, to: Date): TData[]

  // 读取全部（注意大文件）
  readAll(): TData[]

  // 流式读取（大文件友好，逐行解析）
  stream(): AsyncIterable<TData>

  // 获取最新一条
  readLatest(): TData | null

  // 获取数据条数
  count(): number
}
```

在 Strategy 代码中使用：

```javascript
class GeneratedStrategy extends Strategy {
  async execute(context) {
    // 读取 BTC 资金费率最近 24 条
    const history = this.monitorData('FundingRateMonitor', 'BTC').readLast(24)

    // 读取最近 7 天的价格数据
    const prices = this.monitorData('PriceMonitor', 'BTC-USDT').readRange(
      new Date(Date.now() - 7 * 24 * 3600 * 1000),
      new Date()
    )
  }
}
```

---

## 六、内置 Monitor 示例

### FundingRateMonitor

```typescript
class FundingRateMonitor extends BaseMonitor<string, FundingRateData> {
  readonly monitorName = 'FundingRateMonitor'

  constructor(private adapter: PerpExchangeAdapter) {
    super({ ttl: 30 * 24 * 3600 * 1000 }) // 保留 30 天
  }

  async fetch(coin: string): Promise<FundingRateData> {
    return this.adapter.getFundingRate(coin)
  }
}

interface FundingRateData {
  ts: number
  coin: string
  rate: number
  nextFundingTime: number
}
```

### PriceMonitor

```typescript
class PriceMonitor extends BaseMonitor<string, PriceData> {
  readonly monitorName = 'PriceMonitor'

  constructor(private adapter: SpotExchangeAdapter | PerpExchangeAdapter) {
    super({ ttl: 7 * 24 * 3600 * 1000 }) // 保留 7 天
  }

  async fetch(symbol: string): Promise<PriceData> {
    const price = await this.adapter.getPrice(symbol)
    return { ts: Date.now(), symbol, price }
  }
}
```

---

## 七、Monitor 独立运行

Monitor 可以脱离 Runtime 独立运行，用于数据预采集或调试：

```typescript
// 独立运行，每 8 小时采集一次 BTC 资金费率
const monitor = new FundingRateMonitor(new BinanceAdapter())
await monitor.run('BTC', 8 * 3600 * 1000)

// 直接读取一次
const data = await monitor.fetch('BTC')
console.log(data)
```
