# OpenWhale 框架设计文档 — 10 存储方案

---

## 一、设计原则

- **轻量化**：不依赖数据库，所有数据本地文件存储
- **单机友好**：适合个人/小团队本地运行，零外部依赖
- **可读性**：JSONL 格式，可直接用文本工具查看和处理
- **追加写入**：Monitor 数据和执行记录只追加，不修改历史

---

## 二、目录结构

```
~/.openwhale/
  ├── credentials.enc.json          # 加密的 Credentials 存储
  │
  ├── bundles/                      # StrategyBundle 存储
  │   ├── {bundleId}.json
  │   └── ...
  │
  ├── cache/                        # 编译缓存（hash 索引）
  │   ├── {sha256}.json
  │   └── ...
  │
  ├── monitor-data/                 # Monitor 采集数据（JSONL）
  │   ├── FundingRateMonitor/
  │   │   ├── BTC.jsonl
  │   │   └── ETH.jsonl
  │   ├── PriceMonitor/
  │   │   └── BTC-USDT.jsonl
  │   └── {MonitorName}/
  │       └── {key}.jsonl
  │
  ├── executions/                   # 策略执行记录（JSONL）
  │   ├── {bundleId}.jsonl
  │   └── ...
  │
  ├── optimizer/                    # 优化历史（JSONL）
  │   ├── {bundleId}.jsonl
  │   └── ...
  │
  └── logs/                         # 编译日志
      ├── compiler/
      │   └── {timestamp}-{hash}.json
      └── ...
```

---

## 三、各文件格式

### credentials.enc.json

整体 AES-256-GCM 加密，解密后为 JSON 数组：

```json
[
  {
    "id": "cred_01",
    "name": "My Wallet",
    "type": "wallet_private_key",
    "encryptedData": "iv:authTag:encrypted",
    "metadata": { "address": "0xabc...", "network": "ethereum" },
    "createdAt": "2026-04-30T00:00:00Z",
    "updatedAt": "2026-04-30T00:00:00Z"
  }
]
```

### bundles/{bundleId}.json

```json
{
  "id": "bundle_01",
  "description": "当 BTC 资金费率连续 3 次为正且超过 0.01% 时，做空 BTC，止损 5%",
  "triggerConfig": {
    "id": "trigger_01",
    "type": "subscribe",
    "monitorName": "FundingRateMonitor",
    "key": "BTC",
    "strategyBundleId": "bundle_01",
    "enabled": true,
    "filter": { "field": "rate", "op": "gt", "value": 0.0001 }
  },
  "strategyCode": "class GeneratedStrategy extends Strategy { ... }",
  "requiredAdapters": ["perp_exchange"],
  "requiredSkills": [],
  "requiredCredentials": ["My Wallet"],
  "defaultContext": { "coin": "BTC", "stopLossPercent": 5 },
  "allowConcurrent": false,
  "compiledAt": "2026-04-30T00:00:00Z",
  "backtestScore": 0.92
}
```

### monitor-data/{MonitorName}/{key}.jsonl

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
