import type { DatabaseAdapter } from '@openwhaleorg/core'

/**
 * The PnL collector's on/off switch, persisted so a restart keeps what the
 * operator chose — a collector paused to spare a venue's rate budget must
 * not come back on by itself at the next deploy.
 *
 * One row in `ui_prefs` (the gateway's key/value table, see scriptShelf.ts).
 */
const KEY = 'pnl-collector'

export class PnlCollectorPref {
  constructor(private readonly db: DatabaseAdapter) {}

  private async ensure(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS ui_prefs (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  async paused(): Promise<boolean> {
    await this.ensure()
    const row = await this.db.get<{ value: string }>('SELECT value FROM ui_prefs WHERE key = ?', [KEY])
    if (!row) return false
    try { return (JSON.parse(row.value) as { paused?: unknown }).paused === true } catch { return false }
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.ensure()
    await this.db.run(
      `INSERT INTO ui_prefs (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [KEY, JSON.stringify({ paused }), new Date().toISOString()],
    )
  }
}
