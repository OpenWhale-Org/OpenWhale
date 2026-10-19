import type { ExchangeFill, ExchangePosition, FundingEvent } from '@openwhaleorg/exchange'
import { restHeldUntil } from '../restHold.js'
import { replayFills, attributeFunding, returnPct, type Episode } from './positionHistory.js'
import type { Report, PositionRow, HistoryRow, FillRow } from './report.js'

/**
 * Reads one perp account's positions, fills and funding for a range and
 * rebuilds Binance's four tabs from them.
 *
 * Venue-neutral by construction: everything it asks of the session is the
 * adapter surface every ccxt venue shares, plus three optional extras a venue
 * may have — a ledger to discover traded contracts from, a fetch-all-fills
 * call that needs no symbol, and a unified-account flag. What differs per
 * venue is in `VenueLimits`: how wide a fills window may be, how many rows a
 * page holds, how fast to go.
 */

const DAY_MS = 24 * 3600_000
export const DEFAULT_RANGE_MS = 30 * DAY_MS

export interface VenueLimits {
  /** Widest window one fills query may span. */
  fillWindowMs: number
  fillPage: number
  fundingPage: number
  /** Between venue calls. */
  paceMs: number
  maxPagesPerWindow: number
}

/** Binance userTrades: 7-day window, 1000 rows, weight 5 — a quarter second apart is a tenth of the IP budget. */
export const BINANCE_LIMITS: VenueLimits = { fillWindowMs: 6.5 * DAY_MS, fillPage: 1000, fundingPage: 1000, paceMs: 250, maxPagesPerWindow: 50 }

/** Conservative defaults for a venue nobody has measured: 7-day windows, small pages. */
const GENERIC_LIMITS: VenueLimits = { fillWindowMs: 6.5 * DAY_MS, fillPage: 100, fundingPage: 100, paceMs: 300, maxPagesPerWindow: 50 }

const VENUE_LIMITS: Array<[prefix: string, limits: Partial<VenueLimits>]> = [
  ['binance', BINANCE_LIMITS],
  ['aster', BINANCE_LIMITS],
  // userFillsByTime: no symbol filter, 2000 rows a page, the last 10k fills reachable.
  ['hyperliquid', { fillWindowMs: 30 * DAY_MS, fillPage: 2000, fundingPage: 500, paceMs: 300 }],
  // execution/list: 7-day window, 100 rows.
  ['bybit', { fillWindowMs: 6.5 * DAY_MS, fillPage: 100, fundingPage: 100, paceMs: 200 }],
  // fills-history: 3 months reachable, 100 rows.
  ['okx', { fillWindowMs: 30 * DAY_MS, fillPage: 100, fundingPage: 100, paceMs: 200 }],
]

/** Limits for a ccxt exchange id ('binanceusdm', 'hyperliquid', 'bybit', …). */
export function limitsFor(exchangeId: string): VenueLimits {
  const hit = VENUE_LIMITS.find(([prefix]) => exchangeId.startsWith(prefix))
  return { ...GENERIC_LIMITS, ...(hit?.[1] ?? {}) }
}

export interface LeverageRow { longLeverage?: number; shortLeverage?: number; marginMode?: string }

/** What the collector asks of an adapter. Every CcxtAdapter has the required part. */
export interface HistorySession {
  fetchPositionMode(symbol?: string): Promise<{ hedged: boolean }>
  fetchPositions(symbols?: string[]): Promise<ExchangePosition[]>
  fetchFills(symbol: string, since?: number, limit?: number, until?: number): Promise<ExchangeFill[]>
  fetchFundingHistory(since?: number, limit?: number): Promise<FundingEvent[]>
  /** Contracts with ledger rows in the range (venues with a ledger). */
  fetchTradedSymbols?(since?: number, limit?: number, until?: number): Promise<string[]>
  /** Every fill on the account since a time, no symbol needed (Hyperliquid). */
  fetchFillsAll?(since?: number, limit?: number): Promise<ExchangeFill[]>
  /** Binance Portfolio Margin. */
  isUnifiedAccount?: boolean
  exchange: { id: string; has: Record<string, unknown>; fetchLeverages?(symbols?: string[]): Promise<Record<string, unknown>> }
}

export function isHistorySession(x: unknown): x is HistorySession {
  const s = x as Partial<HistorySession> | null
  return !!s && typeof s.fetchFills === 'function' && typeof s.fetchPositions === 'function'
    && typeof s.fetchFundingHistory === 'function' && typeof s.fetchPositionMode === 'function'
    && typeof s.exchange === 'object' && s.exchange !== null && typeof s.exchange.id === 'string'
}

export interface CollectOptions {
  account: string
  venue: string
  source: 'native' | 'ccxt'
  session: HistorySession
  from: number
  to: number
  /** Explicit contracts; empty = discover. */
  symbols: string[]
  limits: VenueLimits
  signal?: AbortSignal | undefined
  emit?: ((line: string) => void) | undefined
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
/**
 * What makes two funding rows the same payment. The venue id alone is not
 * enough: Hyperliquid's is a hash that is zero on every funding entry, and
 * a venue may reuse one id across coins. Symbol, settlement time and amount
 * identify a payment on their own — a coin settles once per hour.
 */
export const fundingKey = (ev: FundingEvent): string => `${ev.id ?? ''}|${ev.symbol}|${ev.timestamp}|${ev.amount}`

export const quoteOf = (symbol: string): string => symbol.split(':')[1] ?? symbol.split('/')[1] ?? 'USDT'
export const iso = (ms: number | undefined) => (ms === undefined ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19))

export async function collectHistory(o: CollectOptions): Promise<Report> {
  const { session, from, to, limits } = o
  const emit = o.emit ?? (() => {})
  const exchangeId = session.exchange.id
  const unified = session.isUnifiedAccount === true
  const notes: string[] = []
  let complete = true

  const aborted = () => o.signal?.aborted === true
  const held = () => restHeldUntil(exchangeId)
  /** One venue call, paced, abandoned when the venue is holding us or the operator stopped. */
  const venue = async <T>(what: string, call: () => Promise<T>): Promise<T | undefined> => {
    if (aborted()) { complete = false; return undefined }
    const until = held()
    if (until !== undefined) {
      complete = false
      notes.push(`${exchangeId} REST is held until ${iso(until)} — ${what} not read`)
      return undefined
    }
    try {
      return await call()
    } catch (err) {
      complete = false
      notes.push(`${what}: ${(err as Error).message}`)
      return undefined
    } finally {
      await sleep(limits.paceMs)
    }
  }

  emit(`Account   ${o.account} on ${o.venue}${o.source === 'ccxt' ? ' (ccxt generic path)' : ''}${unified ? ' (Portfolio Margin)' : ''}`)
  emit(`Range     ${iso(from)} → ${iso(to)} UTC`)

  const mode = await venue('position mode', () => session.fetchPositionMode())
  const hedged = mode?.hedged ?? false
  emit(`Mode      ${hedged ? 'hedge' : 'one-way'}`)

  // ── Discovery ──────────────────────────────────────────────────────────────
  const positions = (await venue('positions', () => session.fetchPositions())) ?? []
  const wanted = new Set<string>(o.symbols)
  const fills: ExchangeFill[] = []
  const seen = new Set<string>()
  const take = (f: ExchangeFill): void => {
    if (seen.has(f.id)) return
    seen.add(f.id)
    if (f.timestamp < from || f.timestamp > to) return
    fills.push(f)
  }

  // A venue that answers for the whole account at once is read that way
  // whatever the symbol list says: one walk through time instead of one per
  // contract, and the contracts fall out of the fills.
  const allAtOnce = typeof session.fetchFillsAll === 'function'
  if (allAtOnce) {
    emit('Reading every fill on the account…')
    let since = from
    for (let page = 0; page < limits.maxPagesPerWindow * 4; page++) {
      const rows = await venue('fills', () => session.fetchFillsAll!(since, limits.fillPage))
      if (rows === undefined) break
      let newest = since
      for (const f of rows) {
        if (o.symbols.length === 0 || wanted.has(f.symbol)) take(f)
        if (f.timestamp > newest) newest = f.timestamp
      }
      if (rows.length < limits.fillPage || newest <= since || newest > to) break
      since = newest
    }
    if (o.symbols.length === 0) {
      for (const f of fills) wanted.add(f.symbol)
      for (const pos of positions) if (pos.contracts !== 0) wanted.add(pos.symbol)
    }
  } else if (wanted.size === 0) {
    if (typeof session.fetchTradedSymbols === 'function' && session.exchange.has['fetchLedger']) {
      emit('Discovering contracts from the ledger…')
      const traded = (await venue('traded contracts', () => session.fetchTradedSymbols!(from, 1000, to))) ?? []
      for (const s of traded) wanted.add(s)
    } else {
      notes.push(`${exchangeId} has no ledger to discover traded contracts from: only contracts with an open position were read — name others in "Contracts"`)
      complete = false
    }
    for (const pos of positions) if (pos.contracts !== 0) wanted.add(pos.symbol)
  }
  const symbols = [...wanted].sort()
  emit(`Contracts ${symbols.length}`)

  // ── Leverage, for ROI ──────────────────────────────────────────────────────
  const leverages = new Map<string, LeverageRow>()
  const lev = await venue('leverages', async () =>
    session.exchange.has['fetchLeverages'] && typeof session.exchange.fetchLeverages === 'function' ? session.exchange.fetchLeverages() : {})
  for (const [symbol, row] of Object.entries((lev ?? {}) as Record<string, LeverageRow>)) leverages.set(symbol, row)
  for (const pos of positions) {
    if (!leverages.has(pos.symbol) && pos.leverage > 0) leverages.set(pos.symbol, { longLeverage: pos.leverage, shortLeverage: pos.leverage, marginMode: pos.marginMode })
  }
  const leverageOf = (symbol: string, direction: 'long' | 'short'): number | undefined => {
    const row = leverages.get(symbol)
    const v = direction === 'long' ? row?.longLeverage : row?.shortLeverage
    return v !== undefined && v > 0 ? v : undefined
  }

  // ── Fills, per contract, in windows the venue allows ───────────────────────
  if (!allAtOnce) {
    let done = 0
    for (const symbol of symbols) {
      if (aborted() || held() !== undefined) break
      let windowStart = from
      while (windowStart < to) {
        const windowEnd = Math.min(windowStart + limits.fillWindowMs, to)
        let since = windowStart
        for (let page = 0; page < limits.maxPagesPerWindow; page++) {
          const rows = await venue(`${symbol} fills`, () => session.fetchFills(symbol, since, limits.fillPage, windowEnd))
          if (rows === undefined) break
          let newest = since
          for (const f of rows) {
            take(f)
            if (f.timestamp > newest) newest = f.timestamp
          }
          if (rows.length < limits.fillPage || newest <= since) break
          since = newest
        }
        windowStart = windowEnd
      }
      done++
      emit(`  ${done}/${symbols.length} ${symbol}: ${fills.length} fills so far`)
    }
  }
  emit(`Fills     ${fills.length}`)

  // ── Funding ────────────────────────────────────────────────────────────────
  const funding: FundingEvent[] = []
  if (session.exchange.has['fetchFundingHistory'] === false) {
    notes.push(`${exchangeId} has no funding history endpoint — funding not read`)
    complete = false
  } else {
    const seenF = new Set<string>()
    let since = from
    for (let page = 0; page < limits.maxPagesPerWindow; page++) {
      const rows = await venue('funding', () => session.fetchFundingHistory(since, limits.fundingPage))
      if (rows === undefined) break
      let newest = since
      for (const ev of rows) {
        const key = fundingKey(ev)
        if (seenF.has(key)) continue
        seenF.add(key)
        if (ev.timestamp >= from && ev.timestamp <= to && (symbols.length === 0 || wanted.has(ev.symbol))) funding.push(ev)
        if (ev.timestamp > newest) newest = ev.timestamp
      }
      if (rows.length < limits.fundingPage || newest <= since || newest > to) break
      since = newest
    }
  }
  emit(`Funding   ${funding.length} payments`)

  // ── Replay ─────────────────────────────────────────────────────────────────
  const replay = replayFills(fills, hedged)
  const orphans = attributeFunding(replay, funding)
  const orphanKeys = new Set(orphans.map(x => `${x.symbol}|${x.timestamp}|${x.amount}`))

  const toHistory = (e: Episode): HistoryRow => {
    const quote = quoteOf(e.symbol)
    const quoteFees = e.fees[quote] ?? 0
    const leverage = leverageOf(e.symbol, e.direction)
    const row = leverages.get(e.symbol)
    const roi = returnPct(e, leverage)
    return {
      symbol: e.symbol, positionSide: e.positionSide, direction: e.direction,
      openedAt: e.openedAt, truncated: e.truncated,
      closedQty: e.closedQty, maxQty: e.maxQty, openAvg: e.openAvg, closeAvg: e.closeAvg,
      tradePnl: e.tradePnl, volumeUsd: e.volume, maxNotional: e.maxQty * (e.openAvg > 0 ? e.openAvg : e.closeAvg),
      fees: e.fees, quoteFees, funding: e.funding,
      net: e.tradePnl - quoteFees + e.funding,
      fillCount: e.fillCount, fillIds: e.fillIds, quote,
      ...(e.closedAt !== undefined ? { closedAt: e.closedAt } : {}),
      ...(leverage !== undefined ? { leverage } : {}),
      ...(row?.marginMode ? { marginMode: row.marginMode } : {}),
      ...(roi !== undefined ? { roiPct: roi } : {}),
      ...(e.estimatedPnl ? { estimated: true } : {}),
    }
  }
  const history = replay.closed.map(toHistory).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0))

  // Open positions: the venue's numbers, joined with what the replay saw of them.
  const openByKey = new Map<string, Episode>()
  for (const e of replay.open) openByKey.set(`${e.symbol}|${e.positionSide}`, e)
  const positionRows: PositionRow[] = positions
    .filter(pos => pos.contracts !== 0)
    .map((pos): PositionRow => {
      const info = (pos.info ?? {}) as Record<string, unknown>
      const positionSide = hedged ? String(info['positionSide'] ?? (pos.side === 'long' ? 'LONG' : 'SHORT')).toUpperCase() : 'BOTH'
      const e = openByKey.get(`${pos.symbol}|${positionSide}`)
      const quote = quoteOf(pos.symbol)
      const margin = pos.marginMode === 'isolated' && Number(info['isolatedMargin']) > 0 ? Number(info['isolatedMargin']) : pos.initialMargin
      // Binance positionRisk v3 carries no leverage; the symbol's configured one does.
      const leverage = pos.leverage > 0 ? pos.leverage : (leverageOf(pos.symbol, pos.side) ?? 0)
      const breakEven = Number(info['breakEvenPrice'])
      const updateTime = Number(info['updateTime'])
      return {
        symbol: pos.symbol, positionSide, direction: pos.side,
        qty: Math.abs(pos.contracts) * (pos.contractSize || 1), notional: Math.abs(pos.notional),
        entryPrice: pos.entryPrice, markPrice: pos.markPrice,
        leverage, marginMode: pos.marginMode, margin, unrealizedPnl: pos.unrealizedPnl,
        truncated: e === undefined || e.truncated,
        ...(Number.isFinite(breakEven) && breakEven > 0 ? { breakEvenPrice: breakEven } : {}),
        ...(pos.liquidationPrice !== undefined && pos.liquidationPrice > 0 ? { liquidationPrice: pos.liquidationPrice } : {}),
        ...(margin > 0 ? { roiPct: (pos.unrealizedPnl / margin) * 100 } : {}),
        ...(e !== undefined && !e.truncated ? { openedAt: e.openedAt } : {}),
        ...(e !== undefined ? { realizedSoFar: e.tradePnl, feesSoFar: e.fees[quote] ?? 0, fundingSoFar: e.funding } : {}),
        ...(Number.isFinite(updateTime) && updateTime > 0 ? { updateTime } : {}),
      }
    })
    .sort((a, b) => b.notional - a.notional)
  // Replay says open, venue says flat: the range ended before the close, or
  // the venue's view is newer. Shown in history as still open.
  for (const e of replay.open) {
    const key = `${e.symbol}|${e.positionSide}`
    if (!positionRows.some(r => `${r.symbol}|${r.positionSide}` === key)) history.unshift(toHistory(e))
  }

  const fillRows: FillRow[] = fills
    .map((f): FillRow => {
      const info = f.info ?? {}
      const maker = info['maker']
      return {
        id: f.id, orderId: f.orderId, time: f.timestamp, symbol: f.symbol, side: f.side,
        positionSide: hedged ? String(info['positionSide'] ?? 'BOTH').toUpperCase() : 'BOTH',
        qty: f.qty, price: f.price, quoteQty: f.qty * f.price,
        ...(f.realizedPnl !== undefined ? { realizedPnl: f.realizedPnl } : {}),
        ...(f.fee !== undefined ? { fee: f.fee } : {}),
        ...(f.feeAsset !== undefined ? { feeAsset: f.feeAsset } : {}),
        ...(typeof maker === 'boolean' ? { maker } : {}),
      }
    })
    .sort((a, b) => b.time - a.time)

  const otherFees: Record<string, number> = {}
  let tradePnl = 0, quoteFees = 0, fundingTotal = 0
  for (const e of [...replay.closed, ...replay.open]) {
    tradePnl += e.tradePnl
    fundingTotal += e.funding
    const quote = quoteOf(e.symbol)
    for (const [asset, v] of Object.entries(e.fees)) {
      if (asset === quote) quoteFees += v
      else otherFees[asset] = (otherFees[asset] ?? 0) + v
    }
  }
  for (const x of orphans) fundingTotal += x.amount
  const unrealizedPnl = positionRows.reduce((s, r) => s + r.unrealizedPnl, 0)
  const volumeUsd = fillRows.reduce((s, r) => s + r.quoteQty, 0)

  return {
    account: o.account, venue: o.venue, source: o.source, unified, hedged, from, to, generatedAt: Date.now(), complete, notes, symbols,
    positions: positionRows, history, fills: fillRows,
    funding: funding.map(ev => ({ ...ev, attributed: !orphanKeys.has(`${ev.symbol}|${ev.timestamp}|${ev.amount}`) })).sort((a, b) => b.timestamp - a.timestamp),
    totals: {
      tradePnl, quoteFees, otherFees, funding: fundingTotal, net: tradePnl - quoteFees + fundingTotal,
      unrealizedPnl, closedEpisodes: replay.closed.length, openPositions: positionRows.length, fills: fills.length, volumeUsd,
    },
  }
}
