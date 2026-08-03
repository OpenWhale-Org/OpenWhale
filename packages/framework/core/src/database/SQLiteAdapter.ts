import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import { AsyncLocalStorage } from 'async_hooks'
import type { DatabaseAdapter, Row } from './DatabaseAdapter.js'
import { SCHEMA_SQL, MIGRATION_SQL } from './schema.js'

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
  /** Serializes transaction() calls — see the comment in transaction(). */
  private txQueue: Promise<unknown> = Promise.resolve()
  /** Tracks "we are inside a transaction() fn" so nested calls join the outer transaction. */
  private readonly txContext = new AsyncLocalStorage<boolean>()

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
    for (const migration of MIGRATION_SQL) {
      try {
        this.db.exec(migration)
      } catch {
        // Already applied (duplicate column) — additive migrations only
      }
    }
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
    // A nested transaction() (fn calling transaction() again) would deadlock on
    // the queue below — join the already-open transaction instead.
    if (this.txContext.getStore()) return fn()

    // All queries share one connection, so a second transaction() starting while
    // an async fn is awaiting would hit "cannot start a transaction within a
    // transaction" (and its statements would join the open one). Chain them.
    const run = this.txQueue.then(() =>
      this.txContext.run(true, async () => {
        const db = this.getDb()
        db.exec('BEGIN')
        try {
          const result = await fn()
          db.exec('COMMIT')
          return result
        } catch (err) {
          db.exec('ROLLBACK')
          throw err
        }
      })
    )
    this.txQueue = run.catch(() => undefined)
    return run
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
