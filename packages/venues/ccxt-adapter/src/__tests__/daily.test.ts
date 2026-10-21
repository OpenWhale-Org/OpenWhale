import { describe, it, expect } from 'vitest'
import { parseZone, parseCutoff, daySpans, instantOf, bucketDays } from '../history/daily.js'
import type { Report } from '../history/report.js'

const H = 3_600_000
const iso = (t: number) => new Date(t).toISOString()

describe('zones and cutoffs', () => {
  it('reads offsets, names and UTC', () => {
    expect(parseZone('')).toMatchObject({ kind: 'fixed', offsetMs: 0 })
    expect(parseZone('+08:00')).toMatchObject({ kind: 'fixed', offsetMs: 8 * H })
    expect(parseZone('UTC+8')).toMatchObject({ kind: 'fixed', offsetMs: 8 * H })
    expect(parseZone('GMT-3:30')).toMatchObject({ kind: 'fixed', offsetMs: -3.5 * H })
    expect(parseZone('Asia/Shanghai')).toMatchObject({ kind: 'iana' })
    expect(parseZone('Mars/Olympus')).toBeUndefined()
  })

  it('reads a time of day', () => {
    expect(parseCutoff('23:59')).toBe(86_340)
    expect(parseCutoff('23:59:00')).toBe(86_340)
    expect(parseCutoff('08:00:30')).toBe(28_830)
    expect(parseCutoff('24:00')).toBeUndefined()
  })

  it('keeps the wall time across a daylight-saving change', () => {
    const ny = parseZone('America/New_York')!
    // 2026-11-01 02:00 EDT → EST. 09:00 local is 13:00Z before, 14:00Z after.
    expect(iso(instantOf(ny, 2026, 10, 31, 9 * 3600))).toBe('2026-10-31T13:00:00.000Z')
    expect(iso(instantOf(ny, 2026, 11, 2, 9 * 3600))).toBe('2026-11-02T14:00:00.000Z')
  })
})

describe('daySpans', () => {
  const sh = parseZone('Asia/Shanghai')!

  it('cuts at 23:59 Shanghai and names each day by its middle', () => {
    const now = Date.parse('2026-10-21T06:00:00Z') // 14:00 in Shanghai
    const spans = daySpans(sh, 86_340, 2, now)
    expect(spans.map(s => [s.label, iso(s.start), s.partial])).toEqual([
      ['2026-10-19', '2026-10-18T15:59:00.000Z', false],
      ['2026-10-20', '2026-10-19T15:59:00.000Z', false],
      ['2026-10-21', '2026-10-20T15:59:00.000Z', true],
    ])
    expect(iso(spans[1]!.end)).toBe('2026-10-20T15:59:00.000Z')
    expect(spans[2]!.end).toBe(now)
  })

  it('does not count today\'s boundary before it has passed', () => {
    const now = Date.parse('2026-10-21T15:00:00Z') // 23:00 Shanghai, before 23:59
    const spans = daySpans(sh, 86_340, 1, now)
    expect(spans.map(s => s.label)).toEqual(['2026-10-20', '2026-10-21'])
    expect(spans[1]!.partial).toBe(true)
  })
})

describe('bucketDays', () => {
  const utc = parseZone('UTC')!
  const now = Date.parse('2026-10-21T12:00:00Z')
  const spans = daySpans(utc, 0, 2, now)
  const t = (s: string) => Date.parse(s)
  const report = {
    account: 'a', venue: 'binance', source: 'native', from: spans[0]!.start, to: now, generatedAt: now, complete: true, notes: [],
    fills: [
      { id: '1', orderId: 'o', time: t('2026-10-19T23:00:00Z'), symbol: 'X/USDT:USDT', side: 'buy', positionSide: 'BOTH', qty: 1, price: 100, quoteQty: 100, fee: 0.05, feeAsset: 'USDT', maker: true },
      { id: '2', orderId: 'o', time: t('2026-10-20T01:00:00Z'), symbol: 'X/USDT:USDT', side: 'sell', positionSide: 'BOTH', qty: 1, price: 103, quoteQty: 103, realizedPnl: 3, fee: 0.05, feeAsset: 'USDT', maker: false },
      { id: '3', orderId: 'o', time: t('2026-10-20T02:00:00Z'), symbol: 'Y/USDC:USDC', side: 'sell', positionSide: 'BOTH', qty: 1, price: 10, quoteQty: 10, pnlEstimate: -1, fee: 0.001, feeAsset: 'BNB' },
      { id: '4', orderId: 'o', time: t('2026-10-21T00:00:00Z'), symbol: 'X/USDT:USDT', side: 'buy', positionSide: 'BOTH', qty: 1, price: 100, quoteQty: 100 },
    ],
    funding: [{ symbol: 'X/USDT:USDT', amount: 0.5, asset: 'USDT', timestamp: t('2026-10-20T00:00:00Z'), attributed: true }],
    history: [{ closedAt: t('2026-10-20T01:00:00Z'), net: 2.4 }],
  } as unknown as Report

  it('books each fill, payment and close on its own day', () => {
    const r = bucketDays(report, spans, { zone: 'UTC', cutoff: '00:00:00' })
    const [d19, d20, d21] = r.days
    expect(d19!.fills).toBe(1)
    expect(d19!.net).toBeCloseTo(-0.05)
    expect(d20!.fills).toBe(2)
    expect(d20!.volume).toBe(113)
    expect(d20!.realized).toBe(2)
    expect(d20!.estimated).toBe(-1)
    expect(d20!.funding).toBe(0.5)
    expect(d20!.otherFees).toEqual({ BNB: 0.001 })
    expect(d20!.net).toBeCloseTo(2 - 0.05 + 0.5)
    expect(d20!.closes).toBe(1)
    expect(d20!.wins).toBe(1)
    expect(d20!.cumulative).toBeCloseTo(-0.05 + 2.45)
    expect(d21!.partial).toBe(true)
    expect(d21!.fills).toBe(1)
    expect(r.totals.wholeDays).toBe(2)
    expect(r.totals.winDays).toBe(1)
    expect(r.totals.lossDays).toBe(1)
    expect(r.totals.makerVolume).toBe(100)
    expect(r.totals.flaggedVolume).toBe(203)
  })
})
