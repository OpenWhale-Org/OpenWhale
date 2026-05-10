# OpenWhale 框架设计文档 — 14 数据库设计

> 更新日期：2026-05-09

---

## 一、存储分层原则

OpenWhale 的持久化层分为两类，各司其职：

| 数据类型 | 存储方式 | 原因 |
|---------|---------|------|
| 时序数据（Monitor 采集记录、Executor 执行日志） | JSONL 文件 | 追加写入，无需随机访问，天然按 key/日期分片，适合流式读取和历史回放 |
| 配置与状态数据（Bundle、Credential、Registry 定义、Strategy 运行时状态） | SQL 数据库 | 需要随机读写、唯一性约束、事务保证，数据量小但访问频繁 |

> 详见 `10-storage.md` 了解 JSONL 文件层的设计。本文档只覆盖 SQL 数据库层。

---

## 二、DatabaseAdapter 接口

SQL 层通过 `DatabaseAdapter` 接口抽象，默认实现为 SQLite（`better-sqlite3`），可替换为 PostgreSQL / MySQL。

```typescript
interface DatabaseAdapter {
  initialize(): Promise<void>                                       // 建表/迁移，Runtime.start() 时调用一次
  run(sql: string, params?: unknown[]): Promise<number>            // INSERT / UPDATE / DELETE，返回影响行数
  all<T>(sql: string, params?: unknown[]): Promise<T[]>            // SELECT 多行
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>  // SELECT 单行
  transaction<T>(fn: () => Promise<T>): Promise<T>                // 事务包装
  close(): Promise<void>
}
```

参数占位符使用 `?`（SQLite 风格），PostgreSQL 适配器需自行转换为 `$1, $2, …`。

`DatabaseAdapter` 通过 `RuntimeOptions.database` 注入 `OpenWhaleRuntime`，由 Runtime 统一管理生命周期（`start()` 时初始化，`stop()` 时关闭）。

---

## 三、表结构

### 3.1 bundles

存储 StrategyBundle 配置，包含触发条件。

```sql
CREATE TABLE IF NOT EXISTS bundles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  strategy_id TEXT NOT NULL,
  triggers    TEXT NOT NULL,   -- JSON: Trigger[]
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
```

| 字段 | 说明 |
|------|------|
| `id` | nanoid 生成，格式 `bundle_xxxxxxxxxx` |
| `strategy_id` | 关联 `registry_strategies.id`（逻辑外键） |
| `triggers` | JSON 序列化的 `Trigger[]`，包含 conditions 和 window |
| `enabled` | 0 = 禁用，1 = 启用 |

写入时机：`Runtime.activate(bundle)` / `Runtime.deactivate(bundleId)`

---

### 3.2 credentials

存储加密后的凭证（API Key、私钥等）。

```sql
CREATE TABLE IF NOT EXISTS credentials (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  encrypted_data TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
```

| 字段 | 说明 |
|------|------|
| `name` | 凭证名称，如 `binance_api_key`，全局唯一 |
| `encrypted_data` | AES-256-GCM 加密，格式 `iv:authTag:ciphertext`（hex） |

加密方案：每条记录独立随机 IV（12 bytes），masterKey 通过 SHA-256 派生为 32 字节密钥。明文永远不落盘。

写入时机：`CredentialStore.set()` / `CredentialStore.delete()`

---

### 3.3 registry_monitors / registry_executors / registry_strategies（暂未启用）

这三张表目前已注释掉，尚未接入写入逻辑。

当前 Registry 的持久化依赖文件系统和内存，详见下方「注册机制」一节。后续若需要跨重启保留注册信息或支持远程查询，再启用这三张表。

---

### 3.4 strategy_store

Strategy 运行时的持久化 KV 状态，通过 `this.store` 访问。

```sql
CREATE TABLE IF NOT EXISTS strategy_store (
  bundle_id   TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,   -- JSON-serialised value
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (bundle_id, key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_store_bundle ON strategy_store (bundle_id);
```

| 字段 | 说明 |
|------|------|
| `bundle_id` | 隔离边界，每个 Bundle 只能读写自己的 key |
| `key` | 任意字符串 |
| `value` | JSON 序列化的值，支持任意 JSON 兼容类型 |

**隔离语义：** `DBStrategyStore` 实例在构造时绑定 `bundleId`，所有 SQL 查询都带 `WHERE bundle_id = ?`，Strategy 代码无法跨 Bundle 访问状态。

Strategy 通过 `this.store` 访问的接口：

```typescript
interface IStrategyStore {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  keys(): Promise<string[]>
  clear(): Promise<void>
}
```

---

## 四、数据流

```
Runtime.start()
    └─ DatabaseAdapter.initialize()    ← 建表（幂等，IF NOT EXISTS）

Runtime.activate(bundle)
    └─ DBBundleStore.save(bundle)      ← INSERT OR REPLACE bundles

TriggerManager 触发 Strategy
    └─ Strategy.run(context)
           ├─ this.store.get/set       ← strategy_store 读写
           └─ this.credential(name)   ← credentials 读取（解密后返回明文）

Runtime.stop()
    └─ DatabaseAdapter.close()
```

---

## 五、注册机制（当前实现）

Monitor / Executor / Strategy 有三条注册路径，最终都写入内存 Registry Map：

### 路径一：代码直接注册（内置组件）

用户在启动代码里手动调用：

```typescript
runtime.registerMonitor(definition, new MyMonitor())
runtime.registerExecutor(definition, new MyExecutor())
runtime.registerStrategy(definition, new MyStrategy())
```

进程重启后需重新调用，无持久化。适合内置组件和开发调试。

### 路径二：Plugin（插件包）

通过 `PluginManager.load(factory, config)` 加载，插件以 `OpenWhalePlugin` 对象的形式一次性声明所有 Monitor / Executor / Strategy：

```typescript
pluginManager.load(hyperliquidPlugin, { apiKey: '...' })
// 插件内部批量调用 registry.register(definition, instance)
```

插件可以通过 `loadFromPath(filePath)` 从文件路径动态加载，支持 `unload` 卸载。进程重启后需重新 load，无持久化。

### 路径三：CompiledLoader（AI 编译产物）

`Runtime.start()` 时自动扫描 `~/.openwhale/registry/{type}/{id}.json` + `~/.openwhale/compiled/{type}/{id}/index.js`，读取 definition 文件并动态 import 编译产物，注册进内存 Registry：

```
~/.openwhale/
  ├── registry/
  │   ├── monitors/{id}.json       ← MonitorDefinition
  │   ├── executors/{id}.json      ← ExecutorDefinition
  │   └── strategies/{id}.json     ← StrategyDefinition
  └── compiled/
      ├── monitors/{id}/index.js   ← esbuild 编译产物
      ├── executors/{id}/index.js
      └── strategies/{id}/index.js
```

这是 AI 编译生成策略的持久化路径——definition JSON 和编译产物文件落盘，重启后自动恢复。`recompile(id, type)` 可热更新编译产物并立即重新注册，无需重启。

### 三条路径对比

| | 代码直接注册 | Plugin | CompiledLoader |
|--|------------|--------|----------------|
| 适用场景 | 内置组件、开发调试 | 第三方插件包 | AI 编译生成的组件 |
| 持久化 | 无 | 无 | 有（文件系统） |
| 重启恢复 | 需重新调用 | 需重新 load | 自动恢复 |
| 热更新 | 不支持 | unload + load | `recompile()` |

### 后续规划

当前三条路径都只写内存，`registry_*` DB 表暂未启用。后续若需要以下能力，再接入 DB：
- 通过 API / Assistant 查询已注册组件列表（不依赖进程内存）
- 多进程/分布式部署时共享注册信息

默认实现 `SQLiteAdapter` 的关键配置：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `journal_mode` | WAL | 写前日志，读写并发性能更好 |
| `foreign_keys` | ON | 启用外键约束（当前为逻辑外键，未强制） |
| `busy_timeout` | 5000ms | 锁等待超时，防止多进程写冲突时立即报错 |

文件路径默认 `~/.openwhale/openwhale.db`，可通过 `SQLiteAdapterOptions.filePath` 自定义。

---

## 六、使用方式

```typescript
import { OpenWhaleRuntime, SQLiteAdapter } from '@openwhale/core'
import path from 'path'
import { homedir } from 'os'

const db = new SQLiteAdapter({
  filePath: path.join(homedir(), '.openwhale', 'openwhale.db'),
})

const runtime = new OpenWhaleRuntime({ database: db })
await runtime.start()  // 自动调用 db.initialize() 建表
```

不传 `database` 时，Runtime 退回文件系统存储（`BundleStore` 写 JSON 文件，`FileCredentialStore` 写 JSONL），行为与之前完全一致。

---

## 七、后续规划

| 事项 | 说明 |
|------|------|
| PostgreSQL 适配器 | 实现 `PostgreSQLAdapter`，`?` 占位符转换为 `$N`，连接池管理 |
| Schema 迁移 | 引入版本号表 `schema_version`，支持增量迁移脚本 |
| Registry DB 持久化 | 当前 Registry 仍为内存 Map，后续通过 DB 实现跨重启保留注册信息 |
| Strategy 运行记录 | 目前规划写 JSONL，后续可考虑写 DB 以支持查询和统计 |
