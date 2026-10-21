import { quoteOf } from './collect.js'
import type { Report } from './report.js'

/**
 * An account's trading cut into days at a time of day the reader chooses.
 *
 * "A day" is whatever the desk calls one: midnight in Shanghai, 23:59 for a
 * book that settles before the hour, 08:00 UTC for funding. The boundary is a
 * wall-clock time in a named zone, resolved to an instant for every date on
 * its own, so a zone with daylight saving still cuts at the same wall time.
 *
 * Everything is attributed by the time it happened: a fill's volume, fee and
 * realized PnL to the day of the fill, a funding payment to the day of the
 * settlement. A position that opens on one day and closes on the next books
 * its PnL on the day it closed, as the venue's own daily PnL does.
 */

const DAY_MS = 86_400_000

// ── Time zones ───────────────────────────────────────────────────────────────

export type Zone = { kind: 'fixed'; offsetMs: number; label: string } | { kind: 'iana'; name: string; label: string }

/** `UTC`, `+08:00`, `UTC+8`, `GMT-3:30` or an IANA name such as `Asia/Shanghai`. */
export function parseZone(raw: string): Zone | undefined {
  const s = raw.trim()
  if (s === '' || /^(utc|gmt|z)$/i.test(s)) return { kind: 'fixed', offsetMs: 0, label: 'UTC' }
  const m = /^(?:utc|gmt)?\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(s)
  if (m) {
    const h = Number(m[2]), min = Number(m[3] ?? 0)
    if (h > 14 || min > 59) return undefined
    const sign = m[1] === '-' ? -1 : 1
    return { kind: 'fixed', offsetMs: sign * (h * 60 + min) * 60_000, label: `UTC${m[1]}${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}` }
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s })
    return { kind: 'iana', name: s, label: s }
  } catch {
    return undefined
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(name: string): Intl.DateTimeFormat {
  let f = formatters.get(name)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: name, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    formatters.set(name, f)
  }
  return f
}

/** Milliseconds the zone's wall clock is ahead of UTC at instant `t`. */
export function offsetAt(zone: Zone, t: number): number {
  if (zone.kind === 'fixed') return zone.offsetMs
  const parts: Record<string, number> = {}
  for (const p of formatter(zone.name).formatToParts(new Date(t))) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  const wall = Date.UTC(parts['year']!, parts['month']! - 1, parts['day']!, parts['hour']!, parts['minute']!, parts['second']!)
  return wall - Math.floor(t / 1000) * 1000
}

/** The zone's calendar date at instant `t`. */
export function dateIn(zone: Zone, t: number): { y: number; m: number; d: number } {
  const w = new Date(t + offsetAt(zone, t))
  return { y: w.getUTCFullYear(), m: w.getUTCMonth() + 1, d: w.getUTCDate() }
}

/** The instant the zone's wall clock reads y-m-d hh:mm:ss. */
export function instantOf(zone: Zone, y: number, m: number, d: number, secOfDay: number): number {
  const wall = Date.UTC(y, m - 1, d) + secOfDay * 1000
  const first = wall - offsetAt(zone, wall)
  return wall - offsetAt(zone, first)
}

/** `23:59`, `23:59:00` → seconds into the day. */
export function parseCutoff(raw: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw.trim())
  if (!m) return undefined
  const h = Number(m[1]), min = Number(m[2]), s = Number(m[3] ?? 0)
  if (h > 23 || min > 59 || s > 59) return undefined
  return h * 3600 + min * 60 + s
}

// ── Days ─────────────────────────────────────────────────────────────────────

export interface DaySpan {
  /** The zone's date the day is named after: the date at its middle. */
  label: string
  weekday: number
  start: number
  end: number
  /** Still running: ends now rather than at a boundary. */
  partial: boolean
}

/**
 * The last `days` whole days ending at the latest boundary at or before
 * `now`, then the day still running. Oldest first.
 */
export function daySpans(zone: Zone, cutoffSec: number, days: number, now: number): DaySpan[] {
  const today = dateIn(zone, now)
  let base = Date.UTC(today.y, today.m - 1, today.d)
  const at = (utcDate: number) => {
    const d = new Date(utcDate)
    return instantOf(zone, d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), cutoffSec)
  }
  if (at(base) > now) base -= DAY_MS
  const bounds: number[] = []
  for (let k = days; k >= 0; k--) bounds.push(at(base - k * DAY_MS))
  const name = (start: number) => {
    const mid = start + DAY_MS / 2
    const { y, m, d } = dateIn(zone, mid)
    return { label: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, weekday: new Date(Date.UTC(y, m - 1, d)).getUTCDay() }
  }
  const spans: DaySpan[] = []
  for (let i = 0; i + 1 < bounds.length; i++) spans.push({ ...name(bounds[i]!), start: bounds[i]!, end: bounds[i + 1]!, partial: false })
  const last = bounds[bounds.length - 1]!
  if (now > last) spans.push({ ...name(last), start: last, end: now, partial: true })
  return spans
}

// ── Aggregation ──────────────────────────────────────────────────────────────

export interface Tally {
  fills: number
  volume: number
  /** Volume of fills the venue marked maker / of fills it marked at all. */
  makerVolume: number
  flaggedVolume: number
  realized: number
  /** Part of `realized` the replay estimated (venue reported no PnL). */
  estimated: number
  quoteFees: number
  otherFees: Record<string, number>
  funding: number
  fundingCount: number
  net: number
}

export interface ContractDay extends Tally { symbol: string }

export interface DayRow extends DaySpan, Tally {
  contracts: ContractDay[]
  /** Episodes that closed in the day, and those of them that netted positive after fees and funding. */
  closes: number
  wins: number
  cumulative: number
}

export interface DailyReport {
  account: string
  venue: string
  source: 'native' | 'ccxt'
  zone: string
  cutoff: string
  from: number
  to: number
  generatedAt: number
  complete: boolean
  notes: string[]
  days: DayRow[]
  totals: Tally & { closes: number; wins: number; winDays: number; lossDays: number; wholeDays: number }
}

const emptyTally = (): Tally => ({
  fills: 0, volume: 0, makerVolume: 0, flaggedVolume: 0, realized: 0, estimated: 0,
  quoteFees: 0, otherFees: {}, funding: 0, fundingCount: 0, net: 0,
})

function add(into: Tally, from: Tally): void {
  into.fills += from.fills
  into.volume += from.volume
  into.makerVolume += from.makerVolume
  into.flaggedVolume += from.flaggedVolume
  into.realized += from.realized
  into.estimated += from.estimated
  into.quoteFees += from.quoteFees
  for (const [a, v] of Object.entries(from.otherFees)) into.otherFees[a] = (into.otherFees[a] ?? 0) + v
  into.funding += from.funding
  into.fundingCount += from.fundingCount
  into.net += from.net
}

/** Index of the span holding `t`, or -1. Spans are contiguous and sorted. */
function spanOf(spans: DaySpan[], t: number): number {
  let lo = 0, hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = spans[mid]!
    if (t < s.start) hi = mid - 1
    else if (t >= s.end && !(s.partial && t === s.end)) lo = mid + 1
    else return mid
  }
  return -1
}

export function bucketDays(report: Report, spans: DaySpan[], meta: { zone: string; cutoff: string }): DailyReport {
  const perDay = spans.map(() => ({ all: emptyTally(), bySymbol: new Map<string, Tally>(), closes: 0, wins: 0 }))
  const cell = (i: number, symbol: string) => {
    const day = perDay[i]!
    let t = day.bySymbol.get(symbol)
    if (!t) day.bySymbol.set(symbol, t = emptyTally())
    return t
  }

  for (const f of report.fills) {
    const i = spanOf(spans, f.time)
    if (i < 0) continue
    const t = cell(i, f.symbol)
    t.fills++
    t.volume += f.quoteQty
    if (f.maker !== undefined) {
      t.flaggedVolume += f.quoteQty
      if (f.maker) t.makerVolume += f.quoteQty
    }
    const pnl = f.realizedPnl ?? f.pnlEstimate ?? 0
    t.realized += pnl
    if (f.realizedPnl === undefined && f.pnlEstimate !== undefined) t.estimated += f.pnlEstimate
    if (f.fee !== undefined && f.fee !== 0) {
      const asset = f.feeAsset ?? quoteOf(f.symbol)
      if (asset === quoteOf(f.symbol)) t.quoteFees += f.fee
      else t.otherFees[asset] = (t.otherFees[asset] ?? 0) + f.fee
    }
  }
  for (const ev of report.funding) {
    const i = spanOf(spans, ev.timestamp)
    if (i < 0) continue
    const t = cell(i, ev.symbol)
    t.funding += ev.amount
    t.fundingCount++
  }
  for (const r of report.history) {
    if (r.closedAt === undefined) continue
    const i = spanOf(spans, r.closedAt)
    if (i < 0) continue
    perDay[i]!.closes++
    if (r.net > 0) perDay[i]!.wins++
  }

  let cumulative = 0
  const days: DayRow[] = spans.map((span, i) => {
    const day = perDay[i]!
    const contracts: ContractDay[] = []
    for (const [symbol, t] of day.bySymbol) {
      t.net = t.realized - t.quoteFees + t.funding
      add(day.all, t)
      contracts.push({ symbol, ...t })
    }
    contracts.sort((a, b) => b.volume - a.volume)
    cumulative += day.all.net
    return { ...span, ...day.all, contracts, closes: day.closes, wins: day.wins, cumulative }
  })

  const totals = { ...emptyTally(), closes: 0, wins: 0, winDays: 0, lossDays: 0, wholeDays: 0 }
  for (const d of days) {
    add(totals, d)
    totals.closes += d.closes
    totals.wins += d.wins
    if (d.partial) continue
    totals.wholeDays++
    if (d.net > 0) totals.winDays++
    else if (d.net < 0) totals.lossDays++
  }

  return {
    account: report.account, venue: report.venue, source: report.source, zone: meta.zone, cutoff: meta.cutoff,
    from: report.from, to: report.to, generatedAt: report.generatedAt, complete: report.complete, notes: report.notes,
    days, totals,
  }
}
