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

/**
 * Records bigger than the block the bisect works in.
 *
 * A settlement session is ~79KB of candles; the window's end used to be "one
 * 64KB block past the bisect", which cut the final record in half every time.
 */
describe('readRange over records larger than a block', () => {
  const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-range-big-'))
  const BIG = 'venue'
  const N = 60
  beforeAll(() => {
    const lines: string[] = []
    // Uneven sizes, 70–130KB, so no window edge lands on a convenient boundary.
    for (let i = 0; i < N; i++) lines.push(JSON.stringify({ ts: T0 + i * 1_000, data: { i, pad: 'x'.repeat(70_000 + (i * 7_919) % 60_000) } }))
    fs.writeFileSync(path.join(bigDir, `${BIG}.jsonl`), lines.join('\n') + '\n')
  })
  afterAll(() => fs.rmSync(bigDir, { recursive: true, force: true }))
  // A low slurp limit makes this 6MB file take the seeking path.
  const big = () => new MonitorDataReaderImpl<{ i: number }>(bigDir, { slurpLimit: 1 << 20 })

  it('keeps the last record of the window, wherever the window ends', async () => {
    const r = big()
    expect(await r.isOversized(BIG)).toBe(true)
    for (const [a, b] of [[0, N - 1], [10, 11], [17, 42], [N - 3, N - 1], [N - 1, N - 1], [0, 0]] as const) {
      const rows = await r.readRange(BIG, T0 + a * 1_000, T0 + b * 1_000)
      expect(rows.map(x => x.data.i)).toEqual(Array.from({ length: b - a + 1 }, (_, k) => a + k))
    }
  })

  it('an open-ended window runs to the end of the file', async () => {
    const rows = await big().readRange(BIG, T0 + (N - 5) * 1_000, Number.MAX_SAFE_INTEGER)
    expect(rows.map(x => x.data.i)).toEqual([N - 5, N - 4, N - 3, N - 2, N - 1])
  })
})
