import { describe, it, expect, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SQLiteAdapter } from '../SQLiteAdapter.js'

/**
 * A fill is identified by (account, symbol, fill_id).
 *
 * Binance numbers futures trades per symbol, so two contracts in one account
 * share an id space. Under the old key the collector's INSERT OR IGNORE threw
 * away whichever real fill arrived second — SKUU lost three closing fills to
 * ids an APP order already held, and the 6.76 contracts never recorded as sold
 * left a position row that could not reach flat.
 */

const FILL_COLS = '(account, fill_id, order_id, instance_id, symbol, side, qty, price, realized_pnl, fee, fee_asset, ts, position_side)'
const VALUES = '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
const fill = (account: string, id: string, symbol: string, ts: number) =>
  [account, id, `o${id}`, null, symbol, 'sell', 1.5, 30.89, 0.5, 0.01, 'USDT', ts, 'LONG']

const dirs: string[] = []
const tempFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-fills-'))
  dirs.push(dir)
  return path.join(dir, 'test.db')
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** The shape the table had before 2026-10-15, indexes included. */
const OLD_SHAPE = `
CREATE TABLE pnl_fills (
  account      TEXT NOT NULL,
  fill_id      TEXT NOT NULL,
  order_id     TEXT NOT NULL,
  instance_id  TEXT,
  symbol       TEXT NOT NULL,
  side         TEXT NOT NULL,
  qty          REAL NOT NULL,
  price        REAL NOT NULL,
  realized_pnl REAL,
  fee          REAL,
  fee_asset    TEXT,
  ts           INTEGER NOT NULL,
  position_side TEXT,
  PRIMARY KEY (account, fill_id)
);
CREATE INDEX idx_pnl_fills_instance ON pnl_fills (instance_id, ts);
CREATE INDEX idx_pnl_fills_account_symbol ON pnl_fills (account, symbol, ts);
CREATE INDEX idx_pnl_fills_account_ts ON pnl_fills (account, ts);
CREATE INDEX idx_pnl_fills_account_order ON pnl_fills (account, order_id);
`

const ddlOf = (filePath: string): string => {
  const raw = new Database(filePath, { readonly: true })
  try {
    return (raw.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pnl_fills'`)
      .get() as { sql: string }).sql
  } finally { raw.close() }
}
const indexesOf = (filePath: string): string[] => {
  const raw = new Database(filePath, { readonly: true })
  try {
    return (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pnl_fills' AND name LIKE 'idx_%' ORDER BY name`)
      .all() as Array<{ name: string }>).map(r => r.name)
  } finally { raw.close() }
}

describe('pnl_fills identity', () => {
  it('keeps two contracts that share one venue trade id', async () => {
    const db = new SQLiteAdapter({ filePath: ':memory:' })
    await db.initialize()
    const insert = `INSERT OR IGNORE INTO pnl_fills ${FILL_COLS} VALUES ${VALUES}`
    // The real collision: APP filled on 09-22, SKUU on 09-27, same trade id.
    await db.run(insert, fill('Binance SubAccount 2', '971319', 'APP/USDT:USDT', 1_000))
    await db.run(insert, fill('Binance SubAccount 2', '971319', 'SKUU/USDT:USDT', 2_000))

    const rows = await db.all<{ symbol: string }>(
      `SELECT symbol FROM pnl_fills WHERE fill_id = '971319' ORDER BY symbol`)
    expect(rows.map(r => r.symbol)).toEqual(['APP/USDT:USDT', 'SKUU/USDT:USDT'])
  })

  it('still reads a repeat of one contract\'s own fill as the same fill', async () => {
    const db = new SQLiteAdapter({ filePath: ':memory:' })
    await db.initialize()
    const insert = `INSERT OR IGNORE INTO pnl_fills ${FILL_COLS} VALUES ${VALUES}`
    await db.run(insert, fill('A', '7', 'SKUU/USDT:USDT', 1_000))
    await db.run(insert, fill('A', '7', 'SKUU/USDT:USDT', 9_999))

    expect(await db.all<{ ts: number }>(`SELECT ts FROM pnl_fills`)).toEqual([{ ts: 1_000 }])
  })

  it('rebuilds a database still keyed on (account, fill_id), keeping every row', async () => {
    const filePath = tempFile()
    const raw = new Database(filePath)
    raw.exec(OLD_SHAPE)
    const stmt = raw.prepare(`INSERT INTO pnl_fills ${FILL_COLS} VALUES ${VALUES}`)
    for (let i = 0; i < 50; i++)
      stmt.run(...fill('Binance SubAccount 2', String(900_000 + i), 'SKUU/USDT:USDT', 1_700_000_000_000 + i))
    raw.close()
    expect(ddlOf(filePath)).toContain('PRIMARY KEY (account, fill_id)')

    const db = new SQLiteAdapter({ filePath })
    await db.initialize()

    expect(ddlOf(filePath)).toContain('PRIMARY KEY (account, symbol, fill_id)')
    expect(await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pnl_fills`)).toEqual({ n: 50 })
    // The old table's indexes went with it; SCHEMA_SQL puts them back.
    expect(indexesOf(filePath)).toEqual([
      'idx_pnl_fills_account_order', 'idx_pnl_fills_account_symbol',
      'idx_pnl_fills_account_ts', 'idx_pnl_fills_instance',
    ])
    // And the collision it was rebuilt for now survives.
    await db.run(`INSERT OR IGNORE INTO pnl_fills ${FILL_COLS} VALUES ${VALUES}`,
      fill('Binance SubAccount 2', '900000', 'APP/USDT:USDT', 1))
    expect(await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pnl_fills`)).toEqual({ n: 51 })
    await db.close()
  })

  it('leaves a rebuilt database alone on the next start', async () => {
    const filePath = tempFile()
    const first = new SQLiteAdapter({ filePath })
    await first.initialize()
    await first.run(`INSERT INTO pnl_fills ${FILL_COLS} VALUES ${VALUES}`, fill('A', '1', 'SKUU/USDT:USDT', 5))
    await first.close()

    const second = new SQLiteAdapter({ filePath })
    await second.initialize()
    expect(ddlOf(filePath)).toContain('PRIMARY KEY (account, symbol, fill_id)')
    expect(await second.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pnl_fills`)).toEqual({ n: 1 })
    expect(await second.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'pnl_fills_rebuild'`)).toEqual({ n: 0 })
    await second.close()
  })
})
