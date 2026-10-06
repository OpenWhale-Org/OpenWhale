import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MonitorDataReaderImpl, sampleByTime } from '../MonitorDataReader.js'

const HOUR = 3_600_000

/** Two weeks of hourly backfill, then a day of one record a second — the etf-engine-quotes shape. */
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-sampled-'))
  const pad = 'x'.repeat(300)
  const lines: string[] = []
  const t0 = 1_780_000_000_000
  for (let h = 0; h < 14 * 24; h++) lines.push(JSON.stringify({ ts: t0 + h * HOUR, data: { kind: 'hour', pad } }))
  const live0 = t0 + 14 * 24 * HOUR
  for (let s = 0; s < 86_400; s++) lines.push(JSON.stringify({ ts: live0 + s * 1000, data: { kind: 'live', pad } }))
  fs.writeFileSync(path.join(dir, 'k.jsonl'), lines.join('\n') + '\n')
  return { dir, t0, live0, end: live0 + 86_399_000 }
}

describe('readSampled', () => {
  it('spans the whole history of an oversized store, sparse stretch included', async () => {
    const { dir, t0, live0, end } = store()
    const reader = new MonitorDataReaderImpl<{ kind: string }>(dir, { slurpLimit: 1 })
    expect(await reader.isOversized('k')).toBe(true)
    const got = await reader.readSampled('k', 400)
    expect(got.length).toBeGreaterThan(200)
    expect(got.length).toBeLessThanOrEqual(400)
    expect(got[0]!.ts).toBe(t0)
    expect(got[got.length - 1]!.ts).toBeGreaterThan(end - 5 * 60_000)
    // Two weeks of hourly records are most of the time span, and a tiny
    // fraction of the bytes: they must still be most of the sample.
    const hourly = got.filter(r => r.data.kind === 'hour').length
    expect(hourly).toBeGreaterThan(got.length * 0.75)
    expect(got.some(r => r.ts >= live0)).toBe(true)
    expect(got.every((r, i) => i === 0 || r.ts > got[i - 1]!.ts)).toBe(true)
  })

  it('a window inside an oversized store comes back at full resolution', async () => {
    const { dir, live0 } = store()
    const reader = new MonitorDataReaderImpl<{ kind: string }>(dir, { slurpLimit: 1 })
    const from = live0 + 3_600_000, to = from + 600_000
    const got = await reader.readSampled('k', 5000, from, to)
    // Ten minutes at one record a second, every one of them, nothing outside.
    expect(got).toHaveLength(601)
    expect(got[0]!.ts).toBe(from)
    expect(got[got.length - 1]!.ts).toBe(to)
    // A window too long to return whole is thinned, and still spans it.
    const wide = await reader.readSampled('k', 300, live0, live0 + 20 * 3_600_000)
    expect(wide.length).toBeLessThanOrEqual(300)
    expect(wide[0]!.ts).toBeLessThan(live0 + 10 * 60_000)
    expect(wide[wide.length - 1]!.ts).toBeGreaterThan(live0 + 19.5 * 3_600_000)
  })

  it('wide records buy fewer points: the read is bounded in bytes', async () => {
    // The funding-rates shape: one ~200KB snapshot a minute, ~60MB on disk.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-sampled-wide-'))
    const pad = 'r'.repeat(200_000)
    const t0 = 1_780_000_000_000
    const fd = fs.openSync(path.join(dir, 'k.jsonl'), 'w')
    for (let m = 0; m < 300; m++) fs.writeSync(fd, JSON.stringify({ ts: t0 + m * 60_000, data: { pad } }) + '\n')
    fs.closeSync(fd)
    const reader = new MonitorDataReaderImpl<{ pad: string }>(dir, { slurpLimit: 1 })
    const got = await reader.readSampled('k', 2000)
    // 16MB of probes at ~400KB per probed pick: dozens of points, not 2000 —
    // and still the whole span.
    expect(got.length).toBeGreaterThanOrEqual(16)
    expect(got.length).toBeLessThanOrEqual(45)
    expect(got[0]!.ts).toBe(t0)
    expect(got[got.length - 1]!.ts).toBeGreaterThan(t0 + 290 * 60_000)
    // The tail obeys the same budget, keeping at least one record.
    const tail = await reader.readLast('k', 1000, 4 << 20)
    expect(tail.length).toBeGreaterThanOrEqual(1)
    expect(tail.length).toBeLessThanOrEqual(26)
    expect(tail[tail.length - 1]!.ts).toBe(t0 + 299 * 60_000)
    expect(await reader.readLast('k', 1000)).toHaveLength(300)
  })

  it('a small store samples in memory the same way', async () => {
    const recs = Array.from({ length: 1000 }, (_, i) => ({ ts: i * 10 }))
    const got = sampleByTime(recs, 11)
    // Evenly spaced instants, each taking the nearest record.
    expect(got[0]!.ts).toBe(0)
    expect(got[got.length - 1]!.ts).toBe(9990)
    expect(got.length).toBe(11)
    expect(sampleByTime(recs.slice(0, 5), 11)).toHaveLength(5)
  })
})
