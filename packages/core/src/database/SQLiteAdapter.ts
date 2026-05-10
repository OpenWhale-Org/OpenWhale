import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import type { DatabaseAdapter, Row } from './DatabaseAdapter.js'
import { SCHEMA_SQL } from './schema.js'

export interface SQLiteAdapterOptions {
  /** Absolute path to the .db file. Directories are created automatically. */
  filePath: string
  /** SQLite busy_timeout in ms (default: 5000). */
  busyTimeout?: number
}

/**
 * SQLite implementation of DatabaseAdapter using better-sqlite3.
 *
 * better-sqlite3 is synchronous at the driver level, so all methods resolve
 * immediately — no thread-pool overhead, no connection pool needed.
 * We still expose an async interface so callers are adapter-agnostic.
 */
export class SQLiteAdapter implements DatabaseAdapter {
  private db: Database.Database | null = null
  private readonly options: Required<SQLiteAdapterOptions>

  constructor(options: SQLiteAdapterOptions) {
    this.options = {
      busyTimeout: 5000,
      ...options,
    }
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.options.filePath)
    fs.mkdirSync(dir, { recursive: true })

    this.db = new Database(this.options.filePath)
    this.db.pragma(`busy_timeout = ${this.options.busyTimeout}`)
    this.db.exec(SCHEMA_SQL)
  }

  async run(sql: string, params: unknown[] = []): Promise<number> {
    const stmt = this.getDb().prepare(sql)
    const result = stmt.run(...params)
    return result.changes
  }

  async all<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.getDb().prepare(sql)
    return stmt.all(...params) as T[]
  }

  async get<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const stmt = this.getDb().prepare(sql)
    return stmt.get(...params) as T | undefined
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const db = this.getDb()
    // better-sqlite3 transactions are synchronous; we wrap the async fn
    // by running it inside a deferred transaction boundary.
    db.exec('BEGIN')
    try {
      const result = await fn()
      db.exec('COMMIT')
      return result
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  async close(): Promise<void> {
    this.db?.close()
    this.db = null
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('SQLiteAdapter not initialized — call initialize() first')
    return this.db
  }
}
