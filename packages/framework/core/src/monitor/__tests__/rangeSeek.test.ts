import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MonitorDataReaderImpl } from '../MonitorDataReader.js'

/**
 * A window is a byte range, not a reason to read the file.
 *
 * The engine writes a quote per tick: twelve pairs, 2GB each, 22GB in all. The
 * old readRange streamed the whole store and kept what fell in the window, so
 * the engine audit — which asks for the minutes around each fill — parsed tens
 * of millions of lines on the gateway's one thread and froze the dashboard.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-range-'))
const KEY = 'venue:PAIR'
const T0 = 1_789_000_000_000
const STEP = 10                      // a record every 10ms, as the engine writes them
const COUNT = 400_000                // ~40MB, past the slurp limit

beforeAll(() => {
  const file = path.join(dir, `${KEY}.jsonl`)
  const out = fs.createWriteStream(file)
  let chunk = ''
  for (let i = 0; i < COUNT; i++) {
    chunk += `${JSON.stringify({ ts: T0 + i * STEP, data: { i, bid: 1 + i / 1e6, ask: 1.001 + i / 1e6, pad: 'x'.repeat(40) } })}\n`
    if (chunk.length > 1 << 20) { out.write(chunk); chunk = '' }
  }
  out.write(chunk)
  out.end()
  return new Promise<void>(r => out.on('close', () => r()))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const reader = () => new MonitorDataReaderImpl<{ i: number }>(dir)

describe('readRange on an oversized store', () => {
  it('returns exactly the window, and reads only it', async () => {
    const r = reader()
    expect(await r.isOversized(KEY)).toBe(true)
    const mid = T0 + (COUNT / 2) * STEP
    const started = Date.now()
    const rows = await r.readRange(KEY, mid, mid + 1_000)
    const took = Date.now() - started

    expect(rows[0]!.ts).toBe(mid)
    expect(rows[rows.length - 1]!.ts).toBe(mid + 1_000)
    expect(rows).toHaveLength(101)
    expect(rows.map(x => x.data.i)).toEqual(rows.map((_, k) => COUNT / 2 + k))
    // Seeking is milliseconds; scanning 40MB of JSON is seconds. The margin is
    // wide because CI machines are slow, not because the difference is small.
    expect(took).toBeLessThan(1_500)
  })

  it('a window at the very start or past the end is still exact', async () => {
    const r = reader()
    expect(await r.readRange(KEY, 0, T0 + 20)).toHaveLength(3)
    expect(await r.readRange(KEY, T0 + COUNT * STEP + 5_000, T0 + COUNT * STEP + 9_000)).toEqual([])
  })

  it('caps a window too big to hold, and says it did', async () => {
    const r = reader()
    const { records, truncated } = await r.readRangeCapped(KEY, T0, T0 + COUNT * STEP, { maxBytes: 64 * 1024 })
    expect(truncated).toBe(true)
    expect(records.length).toBeGreaterThan(100)
    expect(records.length).toBeLessThan(2_000)
    expect(records[0]!.ts).toBe(T0)
  })

  it('reads several windows in one pass, merged and in order', async () => {
    const r = reader()
    const at = (k: number) => T0 + k * STEP
    const rows = await r.readWindows(KEY, [
      { from: at(1_000), to: at(1_010) },
      { from: at(300_000), to: at(300_005) },
      // Overlapping windows are read once.
      { from: at(1_005), to: at(1_020) },
    ])
    expect(rows.map(x => x.data.i)).toEqual([
      ...Array.from({ length: 21 }, (_, k) => 1_000 + k),
      ...Array.from({ length: 6 }, (_, k) => 300_000 + k),
    ])
  })
})
