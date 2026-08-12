/**
 * DDL statements for the OpenWhale SQLite schema.
 *
 * Tables:
 *   strategy_instances — StrategyInstance records
 *   credentials        — AES-256-GCM encrypted credential values
 *   strategy_store     — Instance-scoped KV store for Strategy runtime state
 *   portfolio_*        — Strategy-owned snapshots, fills, decisions, and market bars
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

-- Strategy-owned portfolio history. Unlike strategy_store (current recovery
-- state) and run traces (sampled audit), this journal is append-only reporting
-- data used by paper and live portfolio projections.
CREATE TABLE IF NOT EXISTS portfolio_commits (
  instance_id TEXT NOT NULL,
  commit_id   TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (instance_id, commit_id)
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  instance_id    TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  mode           TEXT NOT NULL,
  starting_equity REAL NOT NULL,
  equity          REAL NOT NULL,
  available       REAL NOT NULL,
  used_margin     REAL NOT NULL,
  realized_pnl    REAL NOT NULL,
  unrealized_pnl  REAL NOT NULL,
  fees            REAL NOT NULL,
  net_pnl         REAL NOT NULL,
  return_pct      REAL NOT NULL,
  positions       TEXT NOT NULL,
  PRIMARY KEY (instance_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_instance_ts ON portfolio_snapshots (instance_id, ts);

CREATE TABLE IF NOT EXISTS portfolio_fills (
  instance_id TEXT NOT NULL,
  fill_id     TEXT NOT NULL,
  plan_id     TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  side        TEXT NOT NULL,
  intent      TEXT NOT NULL,
  quantity    REAL NOT NULL,
  price       REAL NOT NULL,
  notional    REAL NOT NULL,
  fee         REAL NOT NULL,
  realized_pnl REAL NOT NULL,
  reason      TEXT,
  PRIMARY KEY (instance_id, fill_id)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_fills_instance_ts ON portfolio_fills (instance_id, ts);
CREATE INDEX IF NOT EXISTS idx_portfolio_fills_instance_symbol_ts ON portfolio_fills (instance_id, symbol, ts);

CREATE TABLE IF NOT EXISTS portfolio_decisions (
  instance_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  symbol      TEXT NOT NULL,
  action      TEXT NOT NULL,
  confidence  REAL,
  reason      TEXT,
  metadata    TEXT,
  PRIMARY KEY (instance_id, decision_id)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_decisions_instance_ts ON portfolio_decisions (instance_id, ts);
CREATE INDEX IF NOT EXISTS idx_portfolio_decisions_instance_symbol_ts ON portfolio_decisions (instance_id, symbol, ts);

CREATE TABLE IF NOT EXISTS portfolio_market_bars (
  instance_id TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  open        REAL NOT NULL,
  high        REAL NOT NULL,
  low         REAL NOT NULL,
  close       REAL NOT NULL,
  PRIMARY KEY (instance_id, symbol, ts)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_market_bars_instance_ts ON portfolio_market_bars (instance_id, ts);
CREATE INDEX IF NOT EXISTS idx_portfolio_market_bars_instance_symbol_ts ON portfolio_market_bars (instance_id, symbol, ts);

-- ── PnL attribution ledger ────────────────────────────────────────────────────
-- The attribution atom is the ORDER: executors claim the venue order ids they
-- place under an instance; a background collector pulls the venue's fills and
-- funding history and joins them back through the claims. Symbols shared by
-- several instances therefore stay separable — the SOXL problem.

CREATE TABLE IF NOT EXISTS pnl_order_claims (
  account     TEXT NOT NULL,           -- credential name the order was placed with
  order_id    TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  symbol      TEXT NOT NULL,
  executor    TEXT,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (account, order_id)
);
CREATE INDEX IF NOT EXISTS idx_pnl_claims_instance ON pnl_order_claims (instance_id);
CREATE INDEX IF NOT EXISTS idx_pnl_claims_account_symbol ON pnl_order_claims (account, symbol);

CREATE TABLE IF NOT EXISTS pnl_fills (
  account      TEXT NOT NULL,
  fill_id      TEXT NOT NULL,
  order_id     TEXT NOT NULL,
  instance_id  TEXT,                   -- NULL = unclaimed (manual / unknown origin)
  symbol       TEXT NOT NULL,
  side         TEXT NOT NULL,
  qty          REAL NOT NULL,
  price        REAL NOT NULL,
  realized_pnl REAL,
  fee          REAL,
  fee_asset    TEXT,
  ts           INTEGER NOT NULL,
  PRIMARY KEY (account, fill_id)
);
CREATE INDEX IF NOT EXISTS idx_pnl_fills_instance ON pnl_fills (instance_id, ts);
CREATE INDEX IF NOT EXISTS idx_pnl_fills_account_symbol ON pnl_fills (account, symbol, ts);

-- Funding is position-level, not order-level: one venue event may split into
-- several rows, one per instance holding claimed exposure at that moment
-- (share ∝ |net position|). instance_id '' = the unattributed remainder.
CREATE TABLE IF NOT EXISTS pnl_funding (
  account     TEXT NOT NULL,
  event_key   TEXT NOT NULL,           -- venue event id, or ts:symbol:amount
  instance_id TEXT NOT NULL DEFAULT '',
  symbol      TEXT NOT NULL,
  amount      REAL NOT NULL,           -- this row's share (positive = received)
  asset       TEXT NOT NULL,
  shared      INTEGER NOT NULL DEFAULT 0,
  ts          INTEGER NOT NULL,
  PRIMARY KEY (account, event_key, instance_id)
);
CREATE INDEX IF NOT EXISTS idx_pnl_funding_instance ON pnl_funding (instance_id, ts);

CREATE TABLE IF NOT EXISTS pnl_watermarks (
  account TEXT NOT NULL,
  scope   TEXT NOT NULL,               -- 'fills:<symbol>' | 'funding'
  ts      INTEGER NOT NULL,
  PRIMARY KEY (account, scope)
);
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
