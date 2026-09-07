import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { RetentionService } from '../maintenance/retention.js'
import type { SQLiteAdapter, OpenWhaleRuntime } from '@openwhaleorg/core'

let dataDir: string
let svc: RetentionService

/** Enough of the adapter for the matching paths, which never touch SQL. */
const noDb = {
  run: async () => 0,
  all: async () => [],
  get: async () => undefined,
} as unknown as SQLiteAdapter

/** Captures the SQL a run issues, so the history rules can be asserted. */
function recordingDb(policy: Record<string, unknown>) {
  const sql: Array<{ q: string; params: unknown[] }> = []
  const db = {
    run: async (q: string, params: unknown[] = []) => { sql.push({ q, params }); return 0 },
    all: async () => [],
    get: async () => policy,
  } as unknown as SQLiteAdapter
  return { db, sql, inserts: () => sql.filter(e => e.q.includes('INSERT INTO monitor_retention_runs')) }
}

function store(monitor: string, key: string, records: Array<{ ts: number }>): void {
  // Keys containing '/' become nested directories on POSIX — that is how the
  // collector writes them, so the walk has to find them the same way.
  const file = path.join(dataDir, 'monitors', monitor, `${key}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map(r => `${JSON.stringify(r)}\n`).join(''))
}

const DAY = 86_400_000
const now = Date.now()

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-ret-svc-'))
  const runtime = { dataDirPath: dataDir } as unknown as OpenWhaleRuntime
  svc = new RetentionService(noDb, runtime)
  store('funding-rates', 'binance', [{ ts: now - 40 * DAY }, { ts: now - 1 * DAY }])
  store('funding-rates', 'hyperliquid', [{ ts: now - 40 * DAY }, { ts: now - 1 * DAY }])
  store('etf-deviation', 'binance:SNXX/USDT:USDT', [{ ts: now - 40 * DAY }, { ts: now - 1 * DAY }])
  store('etf-deviation', 'binance:SOXS/USDT:USDT', [{ ts: now - 1 * DAY }])
})
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }) })

describe('RetentionService.matches', () => {
  it('finds a key whose name nests into subdirectories', () => {
    const m = svc.matches('etf-deviation', '*')
    expect(m.map(f => f.key).sort()).toEqual(['binance:SNXX/USDT:USDT', 'binance:SOXS/USDT:USDT'])
    for (const f of m) expect(fs.existsSync(f.file)).toBe(true)
  })

  it('globs on the decoded key, not the file path', () => {
    expect(svc.matches('etf-deviation', 'binance:SNXX*').map(f => f.key)).toEqual(['binance:SNXX/USDT:USDT'])
  })

  it("'*' as the monitor spans every store", () => {
    expect(svc.matches('*', '*')).toHaveLength(4)
  })

  it('sorts largest first, so the editor leads with what matters', () => {
    const m = svc.matches('*', '*')
    expect(m[0]!.bytes).toBeGreaterThanOrEqual(m[m.length - 1]!.bytes)
  })

  it('returns nothing for a monitor that does not exist', () => {
    expect(svc.matches('nope', '*')).toEqual([])
  })

  it('refuses to escape the monitors directory', () => {
    expect(svc.matches('../../etc', '*')).toEqual([])
  })
})

describe('RetentionService.apply', () => {
  it('a dry run counts what would go and changes nothing', async () => {
    const before = fs.readFileSync(path.join(dataDir, 'monitors/funding-rates/binance.jsonl'), 'utf8')
    const s = await svc.apply({ monitor: 'funding-rates', keyPattern: '*', keepDays: 7 }, true)
    expect(s.files).toBe(2)
    expect(s.droppedRecords).toBe(2)
    expect(s.bytesFreed).toBeGreaterThan(0)
    expect(fs.readFileSync(path.join(dataDir, 'monitors/funding-rates/binance.jsonl'), 'utf8')).toBe(before)
  })

  it('a real run drops only what is past the horizon', async () => {
    const s = await svc.apply({ monitor: 'funding-rates', keyPattern: '*', keepDays: 7 }, false)
    expect(s.droppedRecords).toBe(2)
    const left = fs.readFileSync(path.join(dataDir, 'monitors/funding-rates/binance.jsonl'), 'utf8').trim().split('\n')
    expect(left).toHaveLength(1)
    expect((JSON.parse(left[0]!) as { ts: number }).ts).toBeGreaterThan(now - 7 * DAY)
  })

  it('leaves untargeted monitors alone', async () => {
    const before = fs.readFileSync(path.join(dataDir, 'monitors/etf-deviation/binance:SNXX/USDT:USDT.jsonl'), 'utf8')
    await svc.apply({ monitor: 'funding-rates', keyPattern: '*', keepDays: 7 }, false)
    expect(fs.readFileSync(path.join(dataDir, 'monitors/etf-deviation/binance:SNXX/USDT:USDT.jsonl'), 'utf8')).toBe(before)
  })

  it('a horizon wider than the data is a no-op', async () => {
    const s = await svc.apply({ monitor: '*', keyPattern: '*', keepDays: 365 }, false)
    expect(s).toMatchObject({ files: 0, droppedRecords: 0, bytesFreed: 0 })
  })
})

describe('RetentionService run history', () => {
  const policyRow = {
    id: 'p1', monitor: 'funding-rates', key_pattern: '*', keep_days: 7,
    enabled: 1, last_run_at: null, last_result: null,
  }

  it('records a pass that deleted something', async () => {
    const { db, inserts } = recordingDb(policyRow)
    const svc = new RetentionService(db, { dataDirPath: dataDir } as unknown as OpenWhaleRuntime)
    const summary = await svc.runPolicy('p1', 'manual')
    expect(summary.droppedRecords).toBe(2)
    expect(inserts()).toHaveLength(1)
    expect(inserts()[0]!.params).toContain('manual')
  })

  it('does NOT record a pass that found nothing — liveness lives on the policy', async () => {
    const { db, sql, inserts } = recordingDb({ ...policyRow, keep_days: 365 })
    const svc = new RetentionService(db, { dataDirPath: dataDir } as unknown as OpenWhaleRuntime)
    const summary = await svc.runPolicy('p1', 'scheduled')
    expect(summary.files).toBe(0)
    expect(inserts()).toHaveLength(0)
    // last_run_at still moves, so "is it running" stays answerable.
    expect(sql.some(e => e.q.includes('SET last_run_at'))).toBe(true)
  })

  it('trims the history after every insert, so the log cannot grow without bound', async () => {
    const { db, sql } = recordingDb(policyRow)
    const svc = new RetentionService(db, { dataDirPath: dataDir } as unknown as OpenWhaleRuntime)
    await svc.runPolicy('p1', 'manual')
    expect(sql.some(e => e.q.includes('DELETE FROM monitor_retention_runs'))).toBe(true)
  })
})
