/**
 * A row returned from a query — plain object with string keys.
 */
export type Row = Record<string, unknown>

/**
 * Minimal SQL adapter interface.
 *
 * Implementations must be synchronous-friendly (SQLite) or async (PostgreSQL).
 * All methods return Promises so callers are implementation-agnostic.
 *
 * Parameterized queries use positional `?` placeholders (SQLite style).
 * Implementations targeting PostgreSQL should translate `?` → `$1, $2, …`.
 */
export interface DatabaseAdapter {
  /**
   * Initialize the database — create tables, run migrations.
   * Called once during Runtime.start().
   */
  initialize(): Promise<void>

  /**
   * Execute a statement that returns no rows (INSERT / UPDATE / DELETE / CREATE).
   * Returns the number of rows affected.
   */
  run(sql: string, params?: unknown[]): Promise<number>

  /**
   * Execute a query and return all matching rows.
   */
  all<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>

  /**
   * Execute a query and return the first matching row, or undefined.
   */
  get<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | undefined>

  /**
   * Execute multiple statements inside a single transaction.
   * If the callback throws, the transaction is rolled back.
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>

  /**
   * Close the database connection.
   */
  close(): Promise<void>
}
