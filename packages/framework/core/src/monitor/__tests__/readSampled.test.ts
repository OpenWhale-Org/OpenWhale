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
