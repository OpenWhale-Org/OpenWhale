import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'

/**
 * Instance-scoped persistent KV store injected into Strategy as `this.store`.
 *
 * Values are JSON-serialised, so any JSON-compatible type is supported.
 * All reads/writes are scoped to a single instanceId — strategies cannot
 * access each other's state.
 */
export interface IStrategyStore {
  get<T = unknown>(key: string): Promise<T | undefined>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  has(key: string): Promise<boolean>
  keys(): Promise<string[]>
  clear(): Promise<void>
}

interface StoreRow {
  [key: string]: unknown
  key: string
  value: string
  updated_at: string
}

export class DBStrategyStore implements IStrategyStore {
  constructor(
    private readonly instanceId: string,
    private readonly db: DatabaseAdapter
  ) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const row = await this.db.get<StoreRow>(
      'SELECT value FROM strategy_store WHERE instance_id = ? AND key = ?',
      [this.instanceId, key]
    )
    return row ? (JSON.parse(row.value) as T) : undefined
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    const now = new Date().toISOString()
    await this.db.run(
      `INSERT INTO strategy_store (instance_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(instance_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [this.instanceId, key, JSON.stringify(value), now]
    )
  }

  async delete(key: string): Promise<void> {
    await this.db.run(
      'DELETE FROM strategy_store WHERE instance_id = ? AND key = ?',
      [this.instanceId, key]
    )
  }

  async has(key: string): Promise<boolean> {
    const row = await this.db.get<{ cnt: number }>(
      'SELECT COUNT(*) AS cnt FROM strategy_store WHERE instance_id = ? AND key = ?',
      [this.instanceId, key]
    )
    return (row?.cnt ?? 0) > 0
  }

  async keys(): Promise<string[]> {
    const rows = await this.db.all<{ key: string }>(
      'SELECT key FROM strategy_store WHERE instance_id = ? ORDER BY key ASC',
      [this.instanceId]
    )
    return rows.map((r) => r.key)
  }

  async clear(): Promise<void> {
    await this.db.run('DELETE FROM strategy_store WHERE instance_id = ?', [this.instanceId])
  }
}
