/**
 * How the Scripts page is arranged: folders, their order, and which scripts
 * the operator has taken off the shelf.
 *
 * This is presentation state, not runtime state — an unmounted script is still
 * registered and still runnable through the API; it just stops occupying the
 * page. That distinction matters: hiding a script must never be mistaken for
 * disabling it, and nothing here can break a plugin.
 *
 * Stored server-side rather than in localStorage because the shelf is a
 * property of the deployment, not of one browser — the same operator on a
 * phone should see the arrangement they built on a laptop.
 */
import type { DatabaseAdapter } from '@openwhaleorg/core'

export interface ScriptFolder {
  id: string
  name: string
  /** Qualified script ids ('<plugin>/<id>'), in display order. */
  scripts: string[]
  collapsed?: boolean
}

export interface ScriptShelf {
  folders: ScriptFolder[]
  /** Qualified script ids taken off the shelf; restorable at any time. */
  unmounted: string[]
}

const KEY = 'scripts.shelf'
const EMPTY: ScriptShelf = { folders: [], unmounted: [] }

export class ScriptShelfService {
  constructor(private readonly db: DatabaseAdapter) {}

  async initialize(): Promise<void> {
    // A generic key/value shelf for UI preferences — the next one of these
    // should be another row here, not another table.
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS ui_prefs (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
  }

  async get(): Promise<ScriptShelf> {
    const row = await this.db.get<{ value: string }>('SELECT value FROM ui_prefs WHERE key = ?', [KEY])
    if (!row) return EMPTY
    try {
      return normalize(JSON.parse(row.value))
    } catch {
      // Corrupt JSON must not take the Scripts page down — an empty shelf just
      // shows every script, which is the pre-feature behaviour.
      return EMPTY
    }
  }

  async put(shelf: unknown): Promise<ScriptShelf> {
    const clean = normalize(shelf)
    await this.db.run(
      `INSERT INTO ui_prefs (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [KEY, JSON.stringify(clean), new Date().toISOString()],
    )
    return clean
  }
}

/**
 * Accept only what the shape allows. The payload comes from the browser, and a
 * malformed shelf would otherwise be stored and then crash every later render
 * — a page that can no longer load is the one thing an arrangement feature
 * must never cause.
 */
function normalize(raw: unknown): ScriptShelf {
  const obj = (raw ?? {}) as Partial<ScriptShelf>
  const seen = new Set<string>()
  const folders: ScriptFolder[] = []
  for (const f of Array.isArray(obj.folders) ? obj.folders : []) {
    if (typeof f?.id !== 'string' || typeof f?.name !== 'string') continue
    // One script belongs to one folder: a duplicate would render twice and the
    // two copies would drift apart on the next move.
    const scripts = (Array.isArray(f.scripts) ? f.scripts : [])
      .filter((s): s is string => typeof s === 'string' && !seen.has(s) && (seen.add(s), true))
    folders.push({ id: f.id, name: f.name.slice(0, 60), scripts, ...(f.collapsed ? { collapsed: true } : {}) })
  }
  const unmounted = (Array.isArray(obj.unmounted) ? obj.unmounted : [])
    .filter((s): s is string => typeof s === 'string')
  return { folders, unmounted: [...new Set(unmounted)] }
}
