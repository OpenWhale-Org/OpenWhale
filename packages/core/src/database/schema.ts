/**
 * DDL statements for the OpenWhale SQLite schema.
 *
 * Tables:
 *   strategy_instances — StrategyInstance records
 *   credentials        — AES-256-GCM encrypted credential values
 *   strategy_store     — Instance-scoped KV store for Strategy runtime state
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS strategy_instances (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  strategy_id TEXT NOT NULL,
  accounts    TEXT,   -- JSON array of credential names, nullable
  params      TEXT,   -- JSON { base, tunable }, nullable
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL,
  data       TEXT NOT NULL,   -- AES-256-GCM encrypted JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- TODO: Registry 持久化（尚未实现）
-- 当前 Monitor / Executor / Strategy 的注册信息只存在内存 Map 中，进程重启后由
-- PluginManager（插件）和 CompiledLoader（AI 编译产物）重新加载。
-- 后续若需要跨重启保留注册信息或支持远程查询，再启用以下三张表。
--
-- CREATE TABLE IF NOT EXISTS registry_monitors (
--   id            TEXT PRIMARY KEY,
--   name          TEXT NOT NULL,
--   description   TEXT,
--   source        TEXT NOT NULL,   -- 'builtin' | 'plugin' | 'compiled'
--   plugin_name   TEXT,
--   compiled_path TEXT,
--   created_at    TEXT NOT NULL,
--   updated_at    TEXT NOT NULL
-- );
--
-- CREATE TABLE IF NOT EXISTS registry_executors (
--   id                TEXT PRIMARY KEY,
--   name              TEXT NOT NULL,
--   description       TEXT,
--   source            TEXT NOT NULL,
--   plugin_name       TEXT,
--   compiled_path     TEXT,
--   supported_actions TEXT NOT NULL,  -- JSON array of strings
--   created_at        TEXT NOT NULL,
--   updated_at        TEXT NOT NULL
-- );
--
-- CREATE TABLE IF NOT EXISTS registry_strategies (
--   id            TEXT PRIMARY KEY,
--   name          TEXT NOT NULL,
--   description   TEXT,
--   source        TEXT NOT NULL,
--   plugin_name   TEXT,
--   compiled_path TEXT,
--   monitor_ids   TEXT NOT NULL,   -- JSON array of strings
--   executor_ids  TEXT NOT NULL,   -- JSON array of strings
--   created_at    TEXT NOT NULL,
--   updated_at    TEXT NOT NULL
-- );

CREATE TABLE IF NOT EXISTS strategy_store (
  instance_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,   -- JSON-serialised value
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (instance_id, key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_store_instance ON strategy_store (instance_id);
`
