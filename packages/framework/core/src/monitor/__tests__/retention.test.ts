import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pruneJsonlByTime, matchesKeyPattern } from '../retention.js'

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
