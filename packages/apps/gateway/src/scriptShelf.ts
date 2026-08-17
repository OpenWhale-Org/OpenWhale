/**
 * How the Scripts page is arranged: which folder each script sits in, its
 * position, and whether the operator has taken it off the shelf.
 *
 * Shaped like the STRATEGY layout on purpose — a folder is a NAME carried by
 * its members plus a sortOrder, not an entity with an id. Same data model,
 * same drag-and-drop semantics, one thing for the operator to learn instead of
 * two: renaming a folder is renaming a string, and folder order derives from
 * the smallest sortOrder inside it.
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

export interface ScriptShelfEntry {
  /** Folder name; absent/empty = ungrouped. */
  folder?: string
  sortOrder?: number
  /** Taken off the shelf — hidden from the page, restorable from Manage. */
  unmounted?: boolean
}

/** Qualified script id ('<plugin>/<id>') → its placement. */
export interface ScriptShelf {
  items: Record<string, ScriptShelfEntry>
}

const KEY = 'scripts.shelf'
const EMPTY: ScriptShelf = { items: {} }

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
      // shows every script, ungrouped, which is the pre-feature behaviour.
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
 * must never cause. Entries that carry no placement at all are dropped rather
 * than stored as empty objects that accumulate forever.
 */
function normalize(raw: unknown): ScriptShelf {
  const src = (raw as { items?: unknown } | null)?.items
  if (!src || typeof src !== 'object') return EMPTY
  const items: Record<string, ScriptShelfEntry> = {}
  for (const [id, value] of Object.entries(src as Record<string, unknown>)) {
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) continue
    const v = (value ?? {}) as ScriptShelfEntry
    const entry: ScriptShelfEntry = {}
    if (typeof v.folder === 'string' && v.folder.trim() !== '') entry.folder = v.folder.trim().slice(0, 60)
    if (typeof v.sortOrder === 'number' && Number.isFinite(v.sortOrder)) entry.sortOrder = v.sortOrder
    if (v.unmounted === true) entry.unmounted = true
    if (Object.keys(entry).length > 0) items[id] = entry
  }
  return { items }
}
