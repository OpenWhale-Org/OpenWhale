import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pruneJsonlByTime, matchesKeyPattern, readLineTs } from '../retention.js'

let dir: string
const file = () => path.join(dir, 'store.jsonl')

function write(lines: string[]): void {
  fs.writeFileSync(file(), lines.map(l => `${l}\n`).join(''))
}
function rec(ts: number, v = 'x'): string {
  return JSON.stringify({ ts, data: { v } })
}
function lines(): string[] {
  return fs.readFileSync(file(), 'utf8').split('\n').filter(Boolean)
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-retention-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('matchesKeyPattern', () => {
  it('treats * and empty as match-all', () => {
    expect(matchesKeyPattern('binance', '*')).toBe(true)
    expect(matchesKeyPattern('binance', '')).toBe(true)
  })

  it('anchors the pattern — a prefix does not match on its own', () => {
    expect(matchesKeyPattern('binance', 'bin')).toBe(false)
    expect(matchesKeyPattern('binance', 'bin*')).toBe(true)
  })

  it('takes regex metacharacters in a symbol literally', () => {
    // The keys people type look like this; '.' and '+' must not act as regex.
    expect(matchesKeyPattern('binance:SNXX/USDT:USDT', 'binance:SNXX*')).toBe(true)
    expect(matchesKeyPattern('binance:SNXXaUSDT', 'binance:SNXX.USDT')).toBe(false)
  })

  it('? spans exactly one character', () => {
    expect(matchesKeyPattern('BTC', 'BT?')).toBe(true)
    expect(matchesKeyPattern('BTCUSD', 'BT?')).toBe(false)
  })
})

describe('pruneJsonlByTime', () => {
  it('drops records older than the cutoff and keeps the rest', async () => {
    write([rec(100), rec(200), rec(300), rec(400)])
    const r = await pruneJsonlByTime(file(), 300)
    expect(r.dropped).toBe(2)
    expect(r.kept).toBe(2)
    expect(r.untouched).toBe(false)
    expect(lines().map(l => (JSON.parse(l) as { ts: number }).ts)).toEqual([300, 400])
    expect(r.bytesAfter).toBeLessThan(r.bytesBefore)
  })

  it('a dry run reports the same counts and writes nothing', async () => {
    write([rec(100), rec(200), rec(300)])
    const before = fs.readFileSync(file(), 'utf8')
    const r = await pruneJsonlByTime(file(), 300, { dryRun: true })
    expect(r.dropped).toBe(2)
    expect(r.untouched).toBe(true)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
    expect(fs.existsSync(`${file()}.prune.tmp`)).toBe(false)
  })

  it('leaves the file byte-identical when nothing is old enough', async () => {
    write([rec(500), rec(600)])
    const before = fs.readFileSync(file(), 'utf8')
    const r = await pruneJsonlByTime(file(), 100)
    expect(r.dropped).toBe(0)
    expect(r.untouched).toBe(true)
    expect(fs.readFileSync(file(), 'utf8')).toBe(before)
  })

  it('KEEPS lines it cannot parse or that carry no ts', async () => {
    // Not symmetric: an unreadable line costs bytes, a dropped one is gone.
    write(['{ this is not json', JSON.stringify({ data: 1 }), rec(100), rec(900)])
    const r = await pruneJsonlByTime(file(), 500)
    expect(r.dropped).toBe(1)
    expect(lines()).toHaveLength(3)
    expect(lines()[0]).toBe('{ this is not json')
  })

  it('preserves a trailing partial line written by a concurrent collector', async () => {
    // The collector appended half a record while the pass was reading. That
    // half lives past the last newline and must survive byte for byte.
    write([rec(100), rec(900)])
    fs.appendFileSync(file(), '{"ts":1000,"data"')
    const r = await pruneJsonlByTime(file(), 500)
    expect(r.dropped).toBe(1)
    const raw = fs.readFileSync(file(), 'utf8')
    expect(raw.endsWith('{"ts":1000,"data"')).toBe(true)
    expect(raw).toContain('"ts":900')
    expect(raw).not.toContain('"ts":100,')
  })

  it('handles a file with no newline at all', async () => {
    fs.writeFileSync(file(), '{"ts":1}')
    const r = await pruneJsonlByTime(file(), 999)
    expect(r.untouched).toBe(true)
    expect(fs.readFileSync(file(), 'utf8')).toBe('{"ts":1}')
  })

  it('handles an empty file', async () => {
    fs.writeFileSync(file(), '')
    const r = await pruneJsonlByTime(file(), 999)
    expect(r).toMatchObject({ bytesBefore: 0, bytesAfter: 0, dropped: 0, untouched: true })
  })

  it('drops every record when all are older than the cutoff', async () => {
    write([rec(1), rec(2)])
    const r = await pruneJsonlByTime(file(), 1000)
    expect(r.dropped).toBe(2)
    expect(r.kept).toBe(0)
    expect(fs.readFileSync(file(), 'utf8')).toBe('')
  })
})

describe('pruneJsonlByTime — bisection on large stores', () => {
  /** What the prune must be equivalent to, done the obvious slow way. */
  function reference(all: string[], cutoff: number): { keptLines: string[]; dropped: number } {
    const keptLines: string[] = []
    let dropped = 0
    for (const l of all) {
      let ts: unknown
      try { ts = (JSON.parse(l) as { ts?: unknown }).ts } catch { ts = undefined }
      if (typeof ts === 'number' && ts < cutoff) dropped++
      else keptLines.push(l)
    }
    return { keptLines, dropped }
  }

  /** ~6MB: well past one probe chunk, so the bisection loop actually runs. */
  function bigStore(): string[] {
    const pad = 'x'.repeat(2000)
    const out: string[] = []
    for (let i = 0; i < 3000; i++) {
      out.push(JSON.stringify({ ts: 1_000 + i * 10, data: { i, pad } }))
      // Unreadable lines sprinkled through, including inside the drop prefix.
      if (i % 397 === 0) out.push('{ not json at all')
      if (i % 613 === 0) out.push(JSON.stringify({ data: 'no ts here' }))
    }
    return out
  }

  it('matches the line-by-line reference at many cutoffs', async () => {
    const all = bigStore()
    for (const cutoff of [0, 1_000, 1_005, 5_000, 17_777, 25_000, 30_990, 31_000, 99_999]) {
      write(all)
      const want = reference(all, cutoff)
      const r = await pruneJsonlByTime(file(), cutoff)
      expect(r.dropped, `dropped at ${cutoff}`).toBe(want.dropped)
      if (want.dropped === 0) {
        expect(r.untouched).toBe(true)
      } else {
        expect(lines(), `lines at ${cutoff}`).toEqual(want.keptLines)
        expect(r.kept).toBe(want.keptLines.length)
      }
      expect(fs.existsSync(`${file()}.prune.tmp`)).toBe(false)
    }
  })

  it('a dry run over a large store agrees with the real pass and writes nothing', async () => {
    const all = bigStore()
    write(all)
    const before = fs.readFileSync(file())
    const dry = await pruneJsonlByTime(file(), 12_345, { dryRun: true })
    expect(fs.readFileSync(file()).equals(before)).toBe(true)
    const real = await pruneJsonlByTime(file(), 12_345)
    expect(dry.dropped).toBe(real.dropped)
    expect(dry.kept).toBe(real.kept)
    expect(dry.bytesAfter).toBe(real.bytesAfter)
  })

  it('handles a single line longer than a probe chunk', async () => {
    const huge = 'y'.repeat(300 * 1024)
    const all = [rec(100), JSON.stringify({ ts: 200, data: huge }), rec(300), JSON.stringify({ ts: 400, data: huge }), rec(500)]
    write(all)
    const r = await pruneJsonlByTime(file(), 350)
    expect(r.dropped).toBe(3)
    expect(lines().map(l => (JSON.parse(l) as { ts: number }).ts)).toEqual([400, 500])
  })

  it('skips the rewrite when too little would be freed', async () => {
    const all = bigStore()
    write(all)
    const before = fs.readFileSync(file())
    // Dropping the first handful of records is far under 5% of the file.
    const r = await pruneJsonlByTime(file(), 1_100, { minDropFraction: 0.05 })
    expect(r.untouched).toBe(true)
    expect(r.dropped).toBe(0)
    expect(fs.readFileSync(file()).equals(before)).toBe(true)
    // …and does it once enough has aged out.
    const r2 = await pruneJsonlByTime(file(), 20_000, { minDropFraction: 0.05 })
    expect(r2.untouched).toBe(false)
    expect(r2.dropped).toBeGreaterThan(0)
  })

  it('errs on the safe side if timestamps are ever out of order', async () => {
    // A stale record appended after newer ones must never cost a NEW record.
    const pad = 'z'.repeat(2000)
    const all: string[] = []
    for (let i = 0; i < 1000; i++) all.push(JSON.stringify({ ts: 10_000 + i, data: pad }))
    all.push(JSON.stringify({ ts: 5, data: 'stale, out of order' }))
    for (let i = 1000; i < 1200; i++) all.push(JSON.stringify({ ts: 10_000 + i, data: pad }))
    write(all)
    await pruneJsonlByTime(file(), 10_500)
    const ts = lines().map(l => (JSON.parse(l) as { ts: number }).ts)
    // Every record at or past the cutoff survived.
    for (let i = 500; i < 1200; i++) expect(ts).toContain(10_000 + i)
    // Everything before it went.
    expect(ts.some(t => t >= 10_000 && t < 10_500)).toBe(false)
  })

  it('leaves a large store alone, without writing, when nothing is old enough', async () => {
    write(bigStore())
    const before = fs.readFileSync(file())
    const r = await pruneJsonlByTime(file(), 500)
    expect(r.untouched).toBe(true)
    expect(fs.readFileSync(file()).equals(before)).toBe(true)
    expect(fs.existsSync(`${file()}.prune.tmp`)).toBe(false)
  })
})

describe('readLineTs', () => {
  const at = (s: string) => { const b = Buffer.from(s); return readLineTs(b, 0, b.length) }

  it('reads BaseMonitor lines from the prefix alone', () => {
    expect(at('{"ts":1789354800000,"data":{"bids":[[1,2]]}}')).toBe(1789354800000)
    expect(at('{"ts":42}')).toBe(42)
  })

  it('falls back to a full parse for other shapes', () => {
    expect(at('{"data":1,"ts":7}')).toBe(7)
    expect(at('{ "ts": 9 }')).toBe(9)
  })

  it('returns undefined when there is no readable ts', () => {
    expect(at('{ not json')).toBeUndefined()
    expect(at('{"data":1}')).toBeUndefined()
    expect(at('{"ts":"soon"}')).toBeUndefined()
  })
})
