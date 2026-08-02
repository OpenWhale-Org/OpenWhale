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
