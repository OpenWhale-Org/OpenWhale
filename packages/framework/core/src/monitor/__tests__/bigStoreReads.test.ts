import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { MonitorDataReaderImpl } from '../MonitorDataReader.js'

/**
 * Oversized stores must never be slurped — the 2026-07-31 production OOM:
 * a 131MB settlement store read whole (×4 concurrent panels, and hourly by
 * the funding strategy) killed a 1.9GB gateway. With slurpLimit forced to
 * 1 byte, every path here exercises the streaming branch.
 */
describe('MonitorDataReaderImpl — oversized stores stream', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-bigstore-'))
  const N = 500
  fs.writeFileSync(path.join(dir, 'venue.jsonl'),
    Array.from({ length: N }, (_, i) => JSON.stringify({ ts: i, data: { i } })).join('\n') + '\n')
  const reader = new MonitorDataReaderImpl<{ i: number }>(dir, { slurpLimit: 1 })

  it('readLast keeps only a ring of n', async () => {
    const last = await reader.readLast('venue', 3)
    expect(last.map(r => r.ts)).toEqual([N - 3, N - 2, N - 1])
  })

  it('readLatest / count / readRange / readAll agree with the file', async () => {
    expect((await reader.readLatest('venue'))!.ts).toBe(N - 1)
    expect(await reader.count('venue')).toBe(N)
    expect((await reader.readRange('venue', 10, 12)).map(r => r.ts)).toEqual([10, 11, 12])
    const all = await reader.readAll('venue')
    expect(all).toHaveLength(N)
    expect(all[0]!.ts).toBe(0)
  })

  it('a missing key is empty everywhere, never a throw', async () => {
    expect(await reader.readAll('nope')).toEqual([])
    expect(await reader.readLast('nope', 5)).toEqual([])
    expect(await reader.readLatest('nope')).toBeNull()
    expect(await reader.count('nope')).toBe(0)
  })

  it('tail reads survive a record larger than one back-chunk', async () => {
    // A record bigger than TAIL_CHUNK forces multiple backwards chunks and a
    // seam inside the line — byte-level accumulation must keep it intact.
    const big = 'x'.repeat(1 << 21)
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-bigline-'))
    fs.writeFileSync(path.join(dir2, 'v.jsonl'),
      JSON.stringify({ ts: 1, data: { blob: big } }) + '\n' + JSON.stringify({ ts: 2, data: { i: 2 } }) + '\n')
    const r2 = new MonitorDataReaderImpl<{ blob?: string; i?: number }>(dir2, { slurpLimit: 1 })
    const last2 = await r2.readLast('v', 2)
    expect(last2.map(x => x.ts)).toEqual([1, 2])
    expect(last2[0]!.data.blob!.length).toBe(1 << 21)
  })

  it('isOversized reflects the slurp limit', async () => {
    expect(await reader.isOversized!('venue')).toBe(true)
    expect(await new MonitorDataReaderImpl(dir).isOversized!('venue')).toBe(false)
  })

  it('small files still use the slurp cache path', async () => {
    const cached = new MonitorDataReaderImpl<{ i: number }>(dir)   // default limit
    expect((await cached.readLast('venue', 2)).map(r => r.ts)).toEqual([N - 2, N - 1])
    expect(await cached.count('venue')).toBe(N)
  })
})

/**
 * Counting an oversized store used to stream it through JSON.parse and throw
 * every record away, keyed on `mtimeMs:size` — both of which change on every
 * append. These stores append ~20x a second, so the cache never hit and every
 * request full-scanned: 2.51s of CPU for 431k records off 178MB measured
 * 2026-09-10, and `funding-rates/binance.jsonl` had reached 7.5GB. The garbage
 * was the multi-second parallel GC pauses that made the dashboard stutter.
 */
describe('count on an oversized store', () => {
  const line = (i: number) => JSON.stringify({ ts: i, data: { i } })

  function store(n: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-count-'))
    const file = path.join(dir, 'venue.jsonl')
    fs.writeFileSync(file, Array.from({ length: n }, (_, i) => line(i)).join('\n') + '\n')
    return { dir, file, reader: new MonitorDataReaderImpl<{ i: number }>(dir, { slurpLimit: 1 }) }
  }

  it('counts records, and keeps counting them as the file grows', async () => {
    const { file, reader } = store(10)
    expect(await reader.count('venue')).toBe(10)
    fs.appendFileSync(file, Array.from({ length: 5 }, (_, i) => line(100 + i)).join('\n') + '\n')
    expect(await reader.count('venue')).toBe(15)
    fs.appendFileSync(file, line(200) + '\n')
    expect(await reader.count('venue')).toBe(16)
  })

  it('a rewritten head restarts the count — retention prunes from the front', async () => {
    const { file, reader } = store(20)
    expect(await reader.count('venue')).toBe(20)
    // What pruning leaves behind: fewer records, and a different first line.
    // Ending up LARGER than before is what would fool a size-only guard.
    fs.writeFileSync(file, Array.from({ length: 12 }, (_, i) =>
      JSON.stringify({ ts: 500 + i, data: { i, pad: 'x'.repeat(200) } })).join('\n') + '\n')
    expect(await reader.count('venue')).toBe(12)
  })

  it('a truncated file restarts the count', async () => {
    const { file, reader } = store(20)
    expect(await reader.count('venue')).toBe(20)
    fs.writeFileSync(file, Array.from({ length: 4 }, (_, i) => line(i)).join('\n') + '\n')
    expect(await reader.count('venue')).toBe(4)
  })

  it('a file without a trailing newline still counts its last record', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-count-nl-'))
    fs.writeFileSync(path.join(dir, 'venue.jsonl'), [line(1), line(2), line(3)].join('\n'))
    const reader = new MonitorDataReaderImpl<{ i: number }>(dir, { slurpLimit: 1 })
    expect(await reader.count('venue')).toBe(3)
  })

  it('two stores do not evict each other', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-count-two-'))
    fs.writeFileSync(path.join(dir, 'a.jsonl'), Array.from({ length: 7 }, (_, i) => line(i)).join('\n') + '\n')
    fs.writeFileSync(path.join(dir, 'b.jsonl'), Array.from({ length: 9 }, (_, i) => line(i)).join('\n') + '\n')
    const reader = new MonitorDataReaderImpl<{ i: number }>(dir, { slurpLimit: 1 })
    expect(await reader.count('a')).toBe(7)
    expect(await reader.count('b')).toBe(9)
    expect(await reader.count('a')).toBe(7)
    expect(await reader.count('b')).toBe(9)
  })
})
