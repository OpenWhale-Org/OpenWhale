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
  accounts    TEXT,   -- JSON array of credential names (legacy positional), nullable
  credentials TEXT,   -- JSON { slotLabel: credentialName } named bindings, nullable
  llm         TEXT,   -- JSON { llmLabel: LlmSlotBinding } overrides, nullable
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

-- TODO: Registry persistence (not yet implemented)
-- Monitor / Executor / Strategy registrations currently live only in an in-memory Map and are
-- reloaded on restart by PluginManager (plugins) and CompiledLoader (AI-compiled artifacts).
-- Enable the three tables below if cross-restart persistence or remote querying is needed.
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

-- Account entities: implementation × credential → a live venue account.
-- kind/type are DERIVED (implementation registration + bound credential), not stored.
CREATE TABLE IF NOT EXISTS accounts (
  name           TEXT PRIMARY KEY,
  implementation TEXT NOT NULL,   -- registered implementation id, e.g. 'exchange/perp-account'
  credential     TEXT,            -- bound credential name; NULL = created but inactive
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- Account equity snapshots — the Accounts page's equity curve. Sampled by the
-- runtime's snapshotter (default 5min), pruned by retention (default 30d).
CREATE TABLE IF NOT EXISTS account_snapshots (
  account        TEXT NOT NULL,
  ts             INTEGER NOT NULL,  -- epoch ms
  equity         REAL NOT NULL,
  available      REAL,
  unrealized_pnl REAL,
  PRIMARY KEY (account, ts)
);

CREATE INDEX IF NOT EXISTS idx_account_snapshots_account_ts ON account_snapshots (account, ts);

-- Monitor instances: a user-created runner of a monitor implementation.
-- One key is only ever produced by one ACTIVE instance (single-active per
-- dispatch domain); data stays keyed by contract, instance-agnostic.
CREATE TABLE IF NOT EXISTS monitor_instances (
  id             TEXT PRIMARY KEY,
  implementation TEXT NOT NULL,   -- implementation id, e.g. 'exchange/funding-rates'
  contract       TEXT NOT NULL,   -- contract id (monitorName) the implementation serves
  credential     TEXT,            -- bound credential name, per the implementation's declaration
  params         TEXT,            -- JSON instance tuning params; editable while inactive, frozen once active
  active         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_store (
  instance_id TEXT NOT NULL,
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,   -- JSON-serialised value
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (instance_id, key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_store_instance ON strategy_store (instance_id);
`

/**
 * Additive migrations for databases created before a column existed.
 * Each statement is idempotent-by-error: "duplicate column" failures are
 * swallowed by the adapter (SQLite has no ADD COLUMN IF NOT EXISTS).
 */
export const MIGRATION_SQL: string[] = [
  // 2026-07-25: per-instance monitor tuning params (editable until activation)
  `ALTER TABLE monitor_instances ADD COLUMN params TEXT`,
  // 2026-07-27: named slot bindings were silently dropped on save — instances
  // restored after a restart lost their accounts and failed to activate
  `ALTER TABLE strategy_instances ADD COLUMN credentials TEXT`,
  `ALTER TABLE strategy_instances ADD COLUMN llm TEXT`,
  `ALTER TABLE strategy_instances ADD COLUMN icon TEXT`,
  `ALTER TABLE strategy_instances ADD COLUMN folder TEXT`,
  `ALTER TABLE strategy_instances ADD COLUMN sort_order INTEGER`,
]
