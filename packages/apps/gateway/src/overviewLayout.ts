import { getDatabase } from './runtime.js'

/**
 * The Overview's arrangement, stored on the ENGINE rather than in a browser.
 *
 * A layout is a statement about which of this engine's numbers matter — the
 * same claim whichever machine asks. Keeping it in localStorage would mean an
 * operator who arranges the page on their laptop opens the server's dashboard
 * to the default, and would lose the arrangement entirely to a cleared cache.
 *
 * The shape is not validated here beyond being JSON. Widget kinds are a
 * dashboard concern that will grow, and a gateway that rejects a kind it has
 * not been taught about would make every new widget a two-package release.
 */

let ready = false

async function ensureTable(): Promise<void> {
  if (ready) return
  await getDatabase().run(`
    CREATE TABLE IF NOT EXISTS overview_layout (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      payload    TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  ready = true
}

/** Null means "never arranged" — the dashboard then draws its default. */
export async function loadOverviewLayout(): Promise<unknown | null> {
  await ensureTable()
  const row = await getDatabase().get<{ payload: string }>('SELECT payload FROM overview_layout WHERE id = 1')
  if (!row) return null
  try {
    return JSON.parse(row.payload) as unknown
  } catch {
    // A payload that will not parse is a layout nobody can use; treating it as
    // absent restores the default rather than leaving the page blank.
    return null
  }
}

export async function saveOverviewLayout(layout: unknown): Promise<void> {
  await ensureTable()
  await getDatabase().run(
    `INSERT INTO overview_layout (id, payload, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    [JSON.stringify(layout), new Date().toISOString()],
  )
}

export async function resetOverviewLayout(): Promise<void> {
  await ensureTable()
  await getDatabase().run('DELETE FROM overview_layout WHERE id = 1')
}
