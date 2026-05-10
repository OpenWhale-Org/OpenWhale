# OpenWhale 框架设计文档 — 10 存储方案

---

## 一、设计原则

存储层分为两类，各司其职：

- **时序数据** → JSONL 文件：追加写入，无需随机访问，可直接用文本工具查看，适合流式读取和历史回放
- **配置与状态数据** → SQL 数据库：需要随机读写、唯一性约束、事务保证

> SQL 数据库层的详细设计（表结构、接口、加密方案）见 `14-database.md`。

---

## 二、目录结构

```
~/.openwhale/
  ├── openwhale.db                  # SQL 数据库（bundles、credentials、strategy_store 等）
  │
  ├── cache/                        # 编译缓存（hash 索引）
  │   ├── {sha256}.json
  │   └── ...
  │
  ├── monitors/                     # Monitor 采集数据（JSONL）
  │   ├── FundingRateMonitor/
  │   │   ├── BTC.jsonl
  │   │   └── ETH.jsonl
  │   ├── PriceMonitor/
  │   │   └── BTC-USDT.jsonl
  │   └── {MonitorName}/
  │       └── {key}.jsonl
  │
  ├── executions/                   # Executor 执行记录（JSONL）
  │   ├── {executorName}/
  │   │   └── {YYYY-MM-DD}.jsonl
  │   └── ...
  │
  ├── optimizer/                    # 优化历史（JSONL）
  │   ├── {bundleId}.jsonl
  │   └── ...
  │
  └── logs/                         # 编译日志
      └── compiler/
          └── {timestamp}-{hash}.json
```

---

## 三、JSONL 文件格式

### monitors/{MonitorName}/{key}.jsonl

每行一个 JSON 对象，必须包含 `ts` 字段（Unix 毫秒时间戳）：

```jsonl
{"ts":1746000000000,"coin":"BTC","rate":0.0001,"nextFundingTime":1746028800000}
{"ts":1746028800000,"coin":"BTC","rate":0.00015,"nextFundingTime":1746057600000}
```

### executions/{bundleId}.jsonl

```jsonl
{"ts":1746028800000,"triggeredAt":"2026-04-30T08:00:00Z","triggerData":{"rate":0.00015},"instructions":[{"type":"market","coin":"BTC","isBuy":false,"size":100}],"results":[{"status":"success","filledSize":100,"avgPrice":95000}],"metrics":{"ruleExecutions":2,"llmCalls":0,"totalTime":150,"totalCost":0}}
```

### optimizer/{bundleId}.jsonl

```jsonl
{"ts":1746100000000,"type":"params","goal":"max_return","bestParams":{"stopLossPercent":8,"positionSizePercent":15},"improvement":{"return":"+23%"}}
{"ts":1746200000000,"type":"strategy","goal":"max_return","changes":"增加了趋势过滤条件，避免在横盘市场频繁开仓","backtestScore":0.91}
```

---

## 四、数据量估算

| 数据类型 | 频率 | 单条大小 | 30天数据量 |
|---------|------|---------|-----------|
| 资金费率（每8小时） | 3次/天 | ~100B | ~9KB/币种 |
| 价格数据（每分钟） | 1440次/天 | ~50B | ~2MB/交易对 |
| 执行记录 | 按需 | ~500B | 视策略而定 |

Monitor 数据量整体较小，JSONL 文件方案完全够用。

---

## 五、数据清理

- Monitor 数据：通过 `ttl` 配置自动清理过期数据
- 编译缓存：手动清理或设置最大缓存数量
- 执行记录：保留全量（用于 Optimizer 分析），可手动归档
