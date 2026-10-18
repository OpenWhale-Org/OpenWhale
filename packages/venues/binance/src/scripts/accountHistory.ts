import { z } from 'zod'
import type { AccountView, ScriptDefinition } from '@openwhaleorg/core'
import type { ExchangeFill, FundingEvent } from '@openwhaleorg/exchange'
import { restHeldUntil } from '@openwhaleorg/ccxt-adapter'
import type { BinanceAdapter } from '../adapter.js'
import { replayFills, attributeFunding, returnPct, type Episode } from '../positionHistory.js'

/**
 * One Binance futures account, the way Binance's own page shows it: open
 * positions, position history, fills and funding — for a time range,
 * from the venue, into one HTML report with those four tabs.
 *
 * Everything is read from the account itself, whoever placed the orders:
 * contracts are discovered from the income ledger (every fill leaves a
 * commission row there), then each contract's fills are read in the 7-day
 * windows `userTrades` allows. The reads are paced and stop at once if the
 * venue is holding this process's REST — a month of a busy account is a few
 * hundred weight-5 calls, and 2026-10-14 showed what a burst of those costs.
 */

const paramsSchema = z.object({
  account: z.string().default('').meta({
    displayName: 'Account',
    description: 'A Binance futures account with a bound credential. Leave empty to use the sole ready one.',
    i18n: { 'zh-CN': { displayName: '账户', description: '已绑定凭证的币安合约账户。留空则使用唯一一个可用账户。' } },
  }),
  from: z.string().default('').meta({
    displayName: 'From',
    description: 'Start of the range. Empty = 30 days before "To".',
    widget: 'datetime',
    i18n: { 'zh-CN': { displayName: '开始时刻', description: '区间起点（按本机时间选，存成 UTC）。留空 = 截止时刻往前 30 天。' } },
  }),
  to: z.string().default('').meta({
    displayName: 'To',
    description: 'End of the range. Empty = now.',
    widget: 'datetime',
    i18n: { 'zh-CN': { displayName: '截止时刻', description: '区间终点。留空 = 现在。' } },
  }),
  symbols: z.string().default('').meta({
    displayName: 'Contracts',
    description: 'Comma-separated, e.g. SOXS/USDT:USDT, SOXL/USDT:USDT. Empty = every contract the account traded in the range.',
    i18n: { 'zh-CN': { displayName: '合约', description: '逗号分隔，如 SOXS/USDT:USDT, SOXL/USDT:USDT。留空 = 区间内账户交易过的全部合约。' } },
  }),
})

const DAY_MS = 24 * 3600_000
const DEFAULT_RANGE_MS = 30 * DAY_MS
/** userTrades refuses a window over 7 days; a little under keeps clear of the venue's rounding. */
const FILL_WINDOW_MS = 6.5 * DAY_MS
const FILL_PAGE = 1000
const FUNDING_PAGE = 1000
/** Between venue calls. Weight 5 each: ~240 weight a minute, a tenth of the IP budget. */
const PACE_MS = 250
const MAX_PAGES_PER_WINDOW = 50

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const parseInstant = (raw: string): number | null | undefined => {
  if (!raw.trim()) return null
  const t = Date.parse(raw.trim())
  return Number.isFinite(t) ? t : undefined
}
const quoteOf = (symbol: string): string => symbol.split(':')[1] ?? symbol.split('/')[1] ?? 'USDT'
const iso = (ms: number | undefined) => (ms === undefined ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19))
const num = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d))
const signed = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`)
const pad = (s: string, w: number) => (s.length >= w ? s : s + ' '.repeat(w - s.length))
const lpad = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s)

interface LeverageRow { longLeverage?: number; shortLeverage?: number; marginMode?: string }

type Runtime = {
  listAccounts(): Promise<AccountView[]>
  adapters: { resolve<T>(kind: string, type: string, credentialName?: string): Promise<T> }
}

export interface PositionRow {
  symbol: string
  positionSide: string
  direction: 'long' | 'short'
  qty: number
  notional: number
  entryPrice: number
  breakEvenPrice?: number
  markPrice: number
  liquidationPrice?: number
  leverage: number
  marginMode: string
  margin: number
  unrealizedPnl: number
  /** Unrealized PnL over margin, as Binance shows it. */
  roiPct?: number
  /** From the replay: when this position was opened, if within the range. */
  openedAt?: number
  truncated: boolean
  realizedSoFar?: number
  feesSoFar?: number
  fundingSoFar?: number
  updateTime?: number
}

export interface HistoryRow {
  symbol: string
  positionSide: string
  direction: 'long' | 'short'
  openedAt: number
  closedAt?: number
  truncated: boolean
  closedQty: number
  maxQty: number
  openAvg: number
  closeAvg: number
  tradePnl: number
  fees: Record<string, number>
  quoteFees: number
  funding: number
  net: number
  leverage?: number
  marginMode?: string
  roiPct?: number
  fillCount: number
  fillIds: string[]
  quote: string
}

export interface FillRow {
  id: string
  orderId: string
  time: number
  symbol: string
  side: 'buy' | 'sell'
  positionSide: string
  qty: number
  price: number
  quoteQty: number
  realizedPnl?: number
  fee?: number
  feeAsset?: string
  maker?: boolean
}

export interface Report {
  account: string
  unified: boolean
  hedged: boolean
  from: number
  to: number
  generatedAt: number
  complete: boolean
  notes: string[]
  symbols: string[]
  positions: PositionRow[]
  history: HistoryRow[]
  fills: FillRow[]
  funding: Array<FundingEvent & { attributed: boolean }>
  totals: {
    tradePnl: number
    quoteFees: number
    otherFees: Record<string, number>
    funding: number
    net: number
    unrealizedPnl: number
    closedEpisodes: number
    openPositions: number
    fills: number
  }
}

export const accountHistoryScript: ScriptDefinition = {
  id: 'account-history',
  name: { en: 'Account history (positions, history, fills, funding)', 'zh-CN': '账户交易历史（持仓 / 仓位历史 / 成交 / 资金费）' },
  description: {
    en: 'Read one Binance futures account from the venue for a time range and produce Binance\'s own four tabs as an HTML report. Read-only.',
    'zh-CN': '按时间范围从币安读取一个合约账户的全部交易，生成与币安页面一致的四个页签（当前持仓 / 仓位历史 / 历史成交 / 资金费用）的 HTML 报告。只读。',
  },
  paramsSchema,

  paramOptions: async (runtime) => {
    const rt = runtime as Runtime
    const accounts = await rt.listAccounts()
    return {
      account: accounts
        .filter(a => a.type === 'binance' && (a.kind ?? 'exchange/perp') === 'exchange/perp' && a.status === 'ready')
        .map(a => ({ value: a.name, label: a.name })),
    }
  },

  run: async ({ params, runtime, emit, signal }) => {
    const p = paramsSchema.parse(params)
    const rt = runtime as Runtime
    const out: string[] = []
    const say = (s = '') => { out.push(s); emit?.(s) }

    const ready = (await rt.listAccounts())
      .filter(a => a.type === 'binance' && (a.kind ?? 'exchange/perp') === 'exchange/perp' && a.status === 'ready')
    if (ready.length === 0) return { text: 'No ready Binance futures account.' }
    const account = p.account === '' ? (ready.length === 1 ? ready[0] : undefined) : ready.find(a => a.name === p.account)
    if (!account) {
      return { text: p.account === ''
        ? `${ready.length} accounts are ready, pick one: ${ready.map(a => a.name).join(', ')}`
        : `No ready Binance futures account named "${p.account}"` }
    }
    if (!account.credential) return { text: `Account "${account.name}" has no bound credential` }

    const toMs = parseInstant(p.to), fromMs = parseInstant(p.from)
    if (toMs === undefined) return { text: `"To" is not a time: ${p.to}` }
    if (fromMs === undefined) return { text: `"From" is not a time: ${p.from}` }
    const to = toMs ?? Date.now()
    const from = fromMs ?? to - DEFAULT_RANGE_MS
    if (from >= to) return { text: 'The range is empty: "From" is not before "To".' }

    const session = await rt.adapters.resolve<BinanceAdapter>('exchange/perp', 'binance', account.credential)
    const unified = session.isUnifiedAccount
    const notes: string[] = []
    let complete = true

    const aborted = () => signal?.aborted === true
    const held = () => restHeldUntil('binanceusdm')
    /** One venue call, paced, abandoned when the venue is holding us or the operator stopped. */
    const venue = async <T>(what: string, call: () => Promise<T>): Promise<T | undefined> => {
      if (aborted()) { complete = false; return undefined }
      const until = held()
      if (until !== undefined) {
        complete = false
        notes.push(`Binance REST is held until ${iso(until)} — ${what} not read`)
        return undefined
      }
      try {
        return await call()
      } catch (err) {
        complete = false
        notes.push(`${what}: ${(err as Error).message}`)
        return undefined
      } finally {
        await sleep(PACE_MS)
      }
    }

    say(`Account   ${account.name}${unified ? ' (Portfolio Margin)' : ''}`)
    say(`Range     ${iso(from)} → ${iso(to)} UTC`)

    const mode = await venue('position mode', () => session.fetchPositionMode())
    const hedged = mode?.hedged ?? false
    say(`Mode      ${hedged ? 'hedge' : 'one-way'}`)

    // ── Discovery ────────────────────────────────────────────────────────────
    const positions = (await venue('positions', () => session.fetchPositions())) ?? []
    const wanted = new Set<string>()
    for (const s of p.symbols.split(',').map(s => s.trim()).filter(Boolean)) wanted.add(s)
    if (wanted.size === 0) {
      emit?.('Discovering contracts from the income ledger…')
      const traded = (await venue('traded contracts', () => session.fetchTradedSymbols(from, 1000, to))) ?? []
      for (const s of traded) wanted.add(s)
      for (const pos of positions) if (pos.contracts !== 0) wanted.add(pos.symbol)
    }
    const symbols = [...wanted].sort()
    say(`Contracts ${symbols.length}`)

    // ── Leverage, for ROI ────────────────────────────────────────────────────
    const leverages = new Map<string, LeverageRow>()
    const lev = await venue('leverages', async () => {
      const ex = (session as unknown as { exchange: { has: Record<string, unknown>; fetchLeverages(symbols?: string[]): Promise<Record<string, LeverageRow>> } }).exchange
      return ex.has['fetchLeverages'] ? ex.fetchLeverages() : {}
    })
    for (const [symbol, row] of Object.entries((lev ?? {}) as Record<string, LeverageRow>)) leverages.set(symbol, row)
    for (const pos of positions) {
      if (!leverages.has(pos.symbol) && pos.leverage > 0) leverages.set(pos.symbol, { longLeverage: pos.leverage, shortLeverage: pos.leverage, marginMode: pos.marginMode })
    }
    const leverageOf = (symbol: string, direction: 'long' | 'short'): number | undefined => {
      const row = leverages.get(symbol)
      const v = direction === 'long' ? row?.longLeverage : row?.shortLeverage
      return v !== undefined && v > 0 ? v : undefined
    }

    // ── Fills, per contract, in 7-day windows ────────────────────────────────
    const fills: ExchangeFill[] = []
    const seen = new Set<string>()
    let done = 0
    for (const symbol of symbols) {
      if (aborted() || held() !== undefined) break
      let windowStart = from
      while (windowStart < to) {
        const windowEnd = Math.min(windowStart + FILL_WINDOW_MS, to)
        let since = windowStart
        for (let page = 0; page < MAX_PAGES_PER_WINDOW; page++) {
          const rows = await venue(`${symbol} fills`, () => session.fetchFills(symbol, since, FILL_PAGE, windowEnd))
          if (rows === undefined) break
          let newest = since
          for (const f of rows) {
            if (seen.has(f.id)) continue
            seen.add(f.id)
            if (f.timestamp < from || f.timestamp > to) continue
            fills.push(f)
            if (f.timestamp > newest) newest = f.timestamp
          }
          if (rows.length < FILL_PAGE || newest <= since) break
          since = newest
        }
        windowStart = windowEnd
      }
      done++
      emit?.(`  ${done}/${symbols.length} ${symbol}: ${fills.length} fills so far`)
    }
    say(`Fills     ${fills.length}`)

    // ── Funding ──────────────────────────────────────────────────────────────
    const funding: FundingEvent[] = []
    {
      const seenF = new Set<string>()
      let since = from
      for (let page = 0; page < MAX_PAGES_PER_WINDOW; page++) {
        const rows = await venue('funding', () => session.fetchFundingHistory(since, FUNDING_PAGE))
        if (rows === undefined) break
        let newest = since
        for (const ev of rows) {
          const key = ev.id ?? `${ev.symbol}|${ev.timestamp}|${ev.amount}`
          if (seenF.has(key)) continue
          seenF.add(key)
          if (ev.timestamp >= from && ev.timestamp <= to && (symbols.length === 0 || wanted.has(ev.symbol))) funding.push(ev)
          if (ev.timestamp > newest) newest = ev.timestamp
        }
        if (rows.length < FUNDING_PAGE || newest <= since || newest > to) break
        since = newest
      }
    }
    say(`Funding   ${funding.length} payments`)

    // ── Replay ───────────────────────────────────────────────────────────────
    const replay = replayFills(fills, hedged)
    const orphans = attributeFunding(replay, funding)
    const orphanKeys = new Set(orphans.map(o => `${o.symbol}|${o.timestamp}|${o.amount}`))

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
        tradePnl: e.tradePnl, fees: e.fees, quoteFees, funding: e.funding,
        net: e.tradePnl - quoteFees + e.funding,
        fillCount: e.fillCount, fillIds: e.fillIds, quote,
        ...(e.closedAt !== undefined ? { closedAt: e.closedAt } : {}),
        ...(leverage !== undefined ? { leverage } : {}),
        ...(row?.marginMode ? { marginMode: row.marginMode } : {}),
        ...(roi !== undefined ? { roiPct: roi } : {}),
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
        // positionRisk v3 carries no leverage; the symbol's configured one does.
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
    for (const o of orphans) fundingTotal += o.amount
    const unrealizedPnl = positionRows.reduce((s, r) => s + r.unrealizedPnl, 0)

    const report: Report = {
      account: account.name, unified, hedged, from, to, generatedAt: Date.now(), complete, notes, symbols,
      positions: positionRows, history, fills: fillRows,
      funding: funding.map(ev => ({ ...ev, attributed: !orphanKeys.has(`${ev.symbol}|${ev.timestamp}|${ev.amount}`) })).sort((a, b) => b.timestamp - a.timestamp),
      totals: {
        tradePnl, quoteFees, otherFees, funding: fundingTotal, net: tradePnl - quoteFees + fundingTotal,
        unrealizedPnl, closedEpisodes: replay.closed.length, openPositions: positionRows.length, fills: fills.length,
      },
    }

    // ── Text ─────────────────────────────────────────────────────────────────
    say()
    say(`Realized  ${signed(tradePnl)}   fees ${num(quoteFees)}${Object.keys(otherFees).length ? ` (+ ${Object.entries(otherFees).map(([a, v]) => `${num(v, 6)} ${a}`).join(', ')})` : ''}   funding ${signed(fundingTotal)}   net ${signed(report.totals.net)}`)
    say(`Open      ${positionRows.length} positions, unrealized ${signed(unrealizedPnl)}`)
    say(`History   ${history.length} episodes (${replay.closed.length} closed)`)
    if (!complete) say('INCOMPLETE — see notes; the report covers what was read.')
    for (const n of notes) say(`  ! ${n}`)
    if (positionRows.length > 0) {
      say()
      say(`${pad('Position', 22)} ${pad('side', 6)} ${lpad('notional $', 12)} ${lpad('entry', 12)} ${lpad('mark', 12)} ${lpad('lev', 4)} ${lpad('uPnL', 10)} ${lpad('ROI%', 8)}  opened`)
      for (const r of positionRows) {
        say(`${pad(r.symbol, 22)} ${pad(r.direction, 6)} ${lpad(num(r.notional), 12)} ${lpad(num(r.entryPrice, 6), 12)} ${lpad(num(r.markPrice, 6), 12)} ${lpad(`${r.leverage}x`, 4)} ${lpad(signed(r.unrealizedPnl), 10)} ${lpad(signed(r.roiPct), 8)}  ${r.openedAt !== undefined ? iso(r.openedAt) : 'before range'}`)
      }
    }
    if (history.length > 0) {
      say()
      say(`${pad('History', 22)} ${pad('side', 6)} ${lpad('closed qty', 12)} ${lpad('open avg', 12)} ${lpad('close avg', 12)} ${lpad('PnL', 10)} ${lpad('ROI%', 8)} ${lpad('fees', 8)} ${lpad('funding', 8)}  opened → closed`)
      for (const r of history.slice(0, 40)) {
        say(`${pad(r.symbol, 22)} ${pad(r.direction, 6)} ${lpad(num(r.closedQty, 4), 12)} ${lpad(num(r.openAvg, 6), 12)} ${lpad(num(r.closeAvg, 6), 12)} ${lpad(signed(r.tradePnl), 10)} ${lpad(signed(r.roiPct), 8)} ${lpad(num(r.quoteFees), 8)} ${lpad(signed(r.funding), 8)}  ${r.truncated ? '<range' : iso(r.openedAt)} → ${r.closedAt !== undefined ? iso(r.closedAt) : 'open'}`)
      }
      if (history.length > 40) say(`  … ${history.length - 40} more in the HTML report`)
    }

    const stamp = new Date(report.generatedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')
    return {
      text: out.join('\n'),
      json: { ...report, fills: undefined, funding: undefined, fillsCount: fillRows.length, fundingCount: funding.length },
      files: [{ name: `binance-${account.name.replace(/[^\w.-]+/g, '_')}-${stamp}.html`, mime: 'text/html', content: renderHtml(report) }],
    }
  },
}

// ── HTML ─────────────────────────────────────────────────────────────────────

/**
 * Fills as columns, not objects: a month of a high-frequency account is a
 * hundred thousand rows, and the field names were most of the 21 MB the
 * first report weighed. The page rebuilds the objects on load.
 */
function compactFills(fills: FillRow[]): { symbols: string[]; feeAssets: string[]; rows: Array<Array<string | number | null>> } {
  const symbols: string[] = [], feeAssets: string[] = []
  const symIdx = new Map<string, number>(), feeIdx = new Map<string, number>()
  const idx = (m: Map<string, number>, list: string[], v: string) => {
    let i = m.get(v)
    if (i === undefined) { i = list.length; list.push(v); m.set(v, i) }
    return i
  }
  const sideIdx: Record<string, number> = { BOTH: 0, LONG: 1, SHORT: 2 }
  const rows = fills.map(f => [
    f.id, f.orderId, f.time, idx(symIdx, symbols, f.symbol), f.side === 'sell' ? 1 : 0, sideIdx[f.positionSide] ?? 0,
    f.qty, f.price, f.realizedPnl ?? null, f.fee ?? null, f.feeAsset === undefined ? -1 : idx(feeIdx, feeAssets, f.feeAsset),
    f.maker === undefined ? -1 : f.maker ? 1 : 0,
  ])
  return { symbols, feeAssets, rows }
}

export function renderHtml(report: Report): string {
  const data = JSON.stringify({ ...report, fills: [], fillCols: compactFills(report.fills) }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(report.account)} · 账户交易历史</title>
<style>
  :root { --bg:#0b0e11; --panel:#161a1e; --line:#2b3139; --text:#eaecef; --muted:#848e9c; --up:#0ecb81; --down:#f6465d; --accent:#f0b90b; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font: 13px/1.45 -apple-system, "Segoe UI", Roboto, "PingFang SC", "Noto Sans SC", sans-serif; }
  header { padding:14px 20px 0; display:flex; flex-wrap:wrap; gap:10px 24px; align-items:baseline; }
  h1 { font-size:16px; margin:0; }
  .meta { color:var(--muted); }
  .meta b { color:var(--text); font-weight:500; }
  .tabs { display:flex; gap:4px; padding:10px 20px 0; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  .tab { padding:8px 12px; cursor:pointer; color:var(--muted); border-bottom:2px solid transparent; user-select:none; }
  .tab.on { color:var(--text); border-color:var(--accent); }
  .tab small { color:var(--muted); margin-left:4px; }
  .bar { display:flex; gap:12px; align-items:center; padding:10px 20px; flex-wrap:wrap; }
  .bar input, .bar select { background:var(--panel); color:var(--text); border:1px solid var(--line); border-radius:4px; padding:5px 8px; font:inherit; }
  .bar label { color:var(--muted); }
  .totals { display:flex; gap:18px; flex-wrap:wrap; padding:0 20px 8px; color:var(--muted); }
  .totals b { color:var(--text); font-weight:500; }
  main { padding:0 20px 40px; overflow-x:auto; }
  table { border-collapse:collapse; width:100%; white-space:nowrap; }
  th, td { padding:7px 10px; border-bottom:1px solid var(--line); text-align:right; font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child, th.l, td.l { text-align:left; }
  th { color:var(--muted); font-weight:500; cursor:pointer; position:sticky; top:0; background:var(--bg); }
  th.sorted::after { content:" ▾"; color:var(--accent); }
  th.sorted.asc::after { content:" ▴"; }
  .up { color:var(--up); } .down { color:var(--down); }
  .sym { font-weight:600; }
  .pill { display:inline-block; font-size:11px; padding:1px 6px; border-radius:3px; background:var(--panel); color:var(--muted); margin-left:6px; }
  .pill.long { color:var(--up); } .pill.short { color:var(--down); }
  .note { color:var(--accent); padding:6px 20px; }
  .empty { color:var(--muted); padding:30px 0; text-align:center; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:12px 14px; margin:10px 0; }
  .card .row { display:grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap:8px 16px; margin-top:8px; }
  .card .k { color:var(--muted); font-size:11px; }
  .card .v { font-size:14px; }
  .card .head { display:flex; justify-content:space-between; flex-wrap:wrap; gap:6px; }
  .card .when { color:var(--muted); font-size:12px; }
  .view { display:none; } .view.on { display:block; }
  .chartbar { display:flex; gap:16px; align-items:center; flex-wrap:wrap; padding:8px 0; color:var(--muted); }
  .chartbar label { cursor:pointer; } .chartbar .hint { font-size:11px; }
  .chartbar b { color:var(--text); font-weight:500; }
  .chartwrap { position:relative; }
  #cv { width:100%; height:460px; display:block; background:var(--panel); border:1px solid var(--line); border-radius:6px; cursor:crosshair; touch-action:none; }
  .tip { position:absolute; pointer-events:none; display:none; background:#1e2329; border:1px solid var(--line); border-radius:4px; padding:6px 8px; font-size:12px; white-space:nowrap; z-index:2; }
  @media (max-width: 720px) { header, .tabs, .bar, .totals, main { padding-left:16px; padding-right:16px; } }
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(report.account)}${report.unified ? ' <span class="pill">统一账户</span>' : ''} <span class="pill">${report.hedged ? '双向持仓' : '单向持仓'}</span></h1>
  <div class="meta">区间 <b data-t="${report.from}"></b> → <b data-t="${report.to}"></b> · 生成于 <b data-t="${report.generatedAt}"></b></div>
  <div class="meta">合约 <b>${report.symbols.length}</b> · 成交 <b>${report.totals.fills}</b> · 已平 <b>${report.totals.closedEpisodes}</b> · 持仓 <b>${report.totals.openPositions}</b></div>
</header>
${report.complete ? '' : `<div class="note">⚠ 数据不完整：${report.notes.map(escapeHtml).join('；')}</div>`}
<div class="totals">
  <span>已实现盈亏 <b class="${cls(report.totals.tradePnl)}">${signed(report.totals.tradePnl)}</b></span>
  <span>手续费 <b>−${num(report.totals.quoteFees)}</b>${Object.keys(report.totals.otherFees).length ? ` <small>(+ ${Object.entries(report.totals.otherFees).map(([a, v]) => `${num(v, 6)} ${a}`).join(', ')})</small>` : ''}</span>
  <span>资金费 <b class="${cls(report.totals.funding)}">${signed(report.totals.funding)}</b></span>
  <span>净盈亏 <b class="${cls(report.totals.net)}">${signed(report.totals.net)}</b></span>
  <span>未实现 <b class="${cls(report.totals.unrealizedPnl)}">${signed(report.totals.unrealizedPnl)}</b></span>
</div>
<div class="tabs">
  <div class="tab on" data-view="positions">仓位<small id="n-positions"></small></div>
  <div class="tab" data-view="history">仓位历史<small id="n-history"></small></div>
  <div class="tab" data-view="fills">历史成交<small id="n-fills"></small></div>
  <div class="tab" data-view="funding">资金费用<small id="n-funding"></small></div>
  <div class="tab" data-view="curve">收益曲线<small id="n-curve"></small></div>
</div>
<div class="bar">
  <label>合约 <input id="q" placeholder="筛选，如 SOXS" size="18"></label>
  <label>时间 <select id="from"><option value="">区间起点</option></select> → <select id="to"><option value="">区间终点</option></select></label>
  <label>时区 <select id="tz"><option value="local">本机</option><option value="Asia/Shanghai">北京</option><option value="UTC">UTC</option></select></label>
  <label>风格 <select id="style"><option value="table">表格</option><option value="cards">卡片</option></select></label>
</div>
<main>
  <div id="positions" class="view on"></div>
  <div id="history" class="view"></div>
  <div id="fills" class="view"></div>
  <div id="funding" class="view"></div>
  <div id="curve" class="view">
    <div class="chartbar">
      <label><input type="checkbox" id="s-trade" checked> 交易盈亏</label>
      <label><input type="checkbox" id="s-fee" checked> 扣手续费</label>
      <label><input type="checkbox" id="s-net" checked> 净值（含资金费）</label>
      <span class="hint">滚轮缩放 · 拖动平移 · 双击复原</span>
      <span id="curve-stats"></span>
    </div>
    <div class="chartwrap"><canvas id="cv"></canvas><div id="tip" class="tip"></div></div>
  </div>
</main>
<script>
const R = ${data};
(() => {
  const c = R.fillCols, ps = ['BOTH', 'LONG', 'SHORT'];
  R.fills = c.rows.map(r => ({ id: r[0], orderId: r[1], time: r[2], symbol: c.symbols[r[3]], side: r[4] ? 'sell' : 'buy', positionSide: ps[r[5]],
    qty: r[6], price: r[7], quoteQty: r[6] * r[7], realizedPnl: r[8] === null ? undefined : r[8], fee: r[9] === null ? undefined : r[9],
    feeAsset: r[10] < 0 ? undefined : c.feeAssets[r[10]], maker: r[11] < 0 ? undefined : r[11] === 1 }));
})();
const $ = s => document.querySelector(s);
const state = { view: 'positions', q: '', tz: 'local', style: 'table', from: '', to: '', sort: {} };
try { state.tz = localStorage.getItem('ow.tz') || 'local'; state.style = localStorage.getItem('ow.style') || 'table'; } catch {}
$('#tz').value = state.tz; $('#style').value = state.style;

const fmtT = ms => {
  if (ms === undefined || ms === null) return '—';
  const d = new Date(ms);
  const opt = { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false };
  if (state.tz !== 'local') opt.timeZone = state.tz;
  return new Intl.DateTimeFormat('zh-CN', opt).format(d).replace(/\\//g, '-');
};
const n = (v, d=2) => (v === undefined || v === null || !isFinite(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sg = (v, d=2) => (v === undefined || v === null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + n(v, d);
const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const px = v => n(v, v >= 100 ? 2 : v >= 1 ? 4 : 6);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const base = s => s.split('/')[0];
const quote = s => (s.split(':')[1] || s.split('/')[1] || 'USDT');
const side = r => '<span class="pill ' + r.direction + '">' + (r.direction === 'long' ? '做多' : '做空') + '</span>';

// Day choices for the in-page range filter.
(() => {
  const days = [];
  for (let t = new Date(R.from).setUTCHours(0,0,0,0); t <= R.to; t += 86400000) days.push(t);
  for (const sel of ['from', 'to']) for (const t of days) {
    const o = document.createElement('option'); o.value = t; o.textContent = new Date(t).toISOString().slice(0, 10); $('#' + sel).appendChild(o);
  }
})();

function inRange(t) {
  if (state.from && t < Number(state.from)) return false;
  if (state.to && t > Number(state.to) + 86400000) return false;
  return true;
}
function match(sym) { return !state.q || sym.toUpperCase().includes(state.q.toUpperCase()); }

function sortRows(rows, view, defKey, defDir) {
  const s = state.sort[view] || { key: defKey, dir: defDir };
  return rows.slice().sort((a, b) => {
    const x = a[s.key], y = b[s.key];
    const c = typeof x === 'string' ? x.localeCompare(y) : ((x ?? -Infinity) - (y ?? -Infinity));
    return s.dir === 'asc' ? c : -c;
  });
}
function th(view, key, label, left) {
  const s = state.sort[view];
  const on = s && s.key === key;
  return '<th class="' + (left ? 'l ' : '') + (on ? 'sorted ' + s.dir : '') + '" data-view="' + view + '" data-key="' + key + '">' + label + '</th>';
}

function renderPositions() {
  const rows = sortRows(R.positions.filter(r => match(r.symbol)), 'positions', 'notional', 'desc');
  $('#n-positions').textContent = '(' + R.positions.length + ')';
  if (!rows.length) return '<div class="empty">没有持仓</div>';
  if (state.style === 'cards') return rows.map(r => \`
    <div class="card">
      <div class="head"><div><span class="sym">\${esc(r.symbol)}</span><span class="pill">永续 \${r.leverage}x</span><span class="pill">\${r.marginMode === 'isolated' ? '逐仓' : '全仓'}</span>\${side(r)}</div>
        <div class="when">\${r.openedAt ? fmtT(r.openedAt) + ' 开仓' : '区间前开仓'}\${r.updateTime ? ' · 最后更新 ' + fmtT(r.updateTime) : ''}</div></div>
      <div class="row">
        <div><div class="k">数量 (\${esc(base(r.symbol))})</div><div class="v">\${n(r.qty, 4)}</div></div>
        <div><div class="k">名义价值</div><div class="v">\${n(r.notional)} \${quote(r.symbol)}</div></div>
        <div><div class="k">开仓价格</div><div class="v">\${px(r.entryPrice)}</div></div>
        <div><div class="k">损益两平价</div><div class="v">\${r.breakEvenPrice ? px(r.breakEvenPrice) : '—'}</div></div>
        <div><div class="k">标记价格</div><div class="v">\${px(r.markPrice)}</div></div>
        <div><div class="k">强平价格</div><div class="v">\${r.liquidationPrice ? px(r.liquidationPrice) : '—'}</div></div>
        <div><div class="k">保证金</div><div class="v">\${n(r.margin)}</div></div>
        <div><div class="k">未实现盈亏 (回报率)</div><div class="v \${cls(r.unrealizedPnl)}">\${sg(r.unrealizedPnl)} (\${sg(r.roiPct)}%)</div></div>
        <div><div class="k">区间内已实现</div><div class="v \${cls(r.realizedSoFar)}">\${sg(r.realizedSoFar)}</div></div>
        <div><div class="k">区间内手续费 / 资金费</div><div class="v">\${n(r.feesSoFar)} / <span class="\${cls(r.fundingSoFar)}">\${sg(r.fundingSoFar)}</span></div></div>
      </div>
    </div>\`).join('');
  return '<table><thead><tr>' + th('positions','symbol','合约',true) + th('positions','qty','数量') + th('positions','notional','名义价值') + th('positions','entryPrice','开仓价格') + th('positions','breakEvenPrice','损益两平价') + th('positions','markPrice','标记价格') + th('positions','liquidationPrice','强平价格') + th('positions','margin','保证金') + th('positions','unrealizedPnl','未实现盈亏') + th('positions','roiPct','回报率') + th('positions','realizedSoFar','区间内已实现') + th('positions','fundingSoFar','区间内资金费') + th('positions','openedAt','开仓时间') + '</tr></thead><tbody>' +
    rows.map(r => '<tr><td class="l"><span class="sym">' + esc(r.symbol) + '</span><span class="pill">' + r.leverage + 'x</span><span class="pill">' + (r.marginMode === 'isolated' ? '逐仓' : '全仓') + '</span>' + side(r) + '</td>' +
      '<td>' + n(r.qty, 4) + '</td><td>' + n(r.notional) + '</td><td>' + px(r.entryPrice) + '</td><td>' + (r.breakEvenPrice ? px(r.breakEvenPrice) : '—') + '</td><td>' + px(r.markPrice) + '</td><td>' + (r.liquidationPrice ? px(r.liquidationPrice) : '—') + '</td><td>' + n(r.margin) + '</td>' +
      '<td class="' + cls(r.unrealizedPnl) + '">' + sg(r.unrealizedPnl) + '</td><td class="' + cls(r.roiPct) + '">' + sg(r.roiPct) + '%</td><td class="' + cls(r.realizedSoFar) + '">' + sg(r.realizedSoFar) + '</td><td class="' + cls(r.fundingSoFar) + '">' + sg(r.fundingSoFar) + '</td><td>' + (r.openedAt ? fmtT(r.openedAt) : '区间前') + '</td></tr>').join('') + '</tbody></table>';
}

function renderHistory() {
  const all = R.history.filter(r => match(r.symbol) && inRange(r.closedAt ?? r.openedAt));
  const rows = sortRows(all, 'history', 'closedAt', 'desc');
  $('#n-history').textContent = '(' + R.history.length + ')';
  if (!rows.length) return '<div class="empty">区间内没有仓位记录</div>';
  // Per-contract totals over the filtered episodes: what the contract made in
  // the range, which no single episode says.
  const bySym = new Map();
  for (const r of all) {
    const a = bySym.get(r.symbol) || { symbol: r.symbol, episodes: 0, open: 0, closedQty: 0, tradePnl: 0, quoteFees: 0, funding: 0, net: 0 };
    a.episodes++; if (!r.closedAt) a.open++; a.closedQty += r.closedQty; a.tradePnl += r.tradePnl; a.quoteFees += r.quoteFees; a.funding += r.funding; a.net += r.net;
    bySym.set(r.symbol, a);
  }
  const sums = sortRows([...bySym.values()], 'historySum', 'net', 'desc');
  const summary = '<details' + (state.sumOpen ? ' open' : '') + ' id="history-sum"><summary style="cursor:pointer;color:var(--muted);padding:6px 0">按合约汇总（' + sums.length + ' 个合约）</summary><table><thead><tr>' + th('historySum','symbol','合约',true) + th('historySum','episodes','仓位段') + th('historySum','closedQty','已平仓量') + th('historySum','tradePnl','已实现盈亏') + th('historySum','quoteFees','手续费') + th('historySum','funding','资金费') + th('historySum','net','净盈亏') + '</tr></thead><tbody>' +
    sums.map(a => '<tr><td class="l sym">' + esc(a.symbol) + '</td><td>' + a.episodes + (a.open ? ' <span class="pill">' + a.open + ' 持仓中</span>' : '') + '</td><td>' + n(a.closedQty, 4) + '</td><td class="' + cls(a.tradePnl) + '">' + sg(a.tradePnl) + '</td><td>' + n(a.quoteFees) + '</td><td class="' + cls(a.funding) + '">' + sg(a.funding) + '</td><td class="' + cls(a.net) + '">' + sg(a.net) + '</td></tr>').join('') + '</tbody></table></details>';
  if (state.style === 'cards') return summary + rows.map(r => \`
    <div class="card">
      <div class="head"><div><span class="sym">\${esc(r.symbol)}</span><span class="pill">永续\${r.leverage ? ' ' + r.leverage + 'x' : ''}</span>\${r.marginMode ? '<span class="pill">' + (r.marginMode === 'isolated' ? '逐仓' : '全仓') + '</span>' : ''}\${side(r)}<span class="pill">\${r.closedAt ? '全部平仓' : '持仓中'}</span>\${r.truncated ? '<span class="pill">区间前开仓</span>' : ''}</div>
        <div class="when">\${r.truncated ? '区间前' : fmtT(r.openedAt)} 开仓时间 | \${r.closedAt ? fmtT(r.closedAt) + ' 最后平仓时间' : '未平'}</div></div>
      <div class="row">
        <div><div class="k">已实现盈亏 (\${quote(r.symbol)})</div><div class="v \${cls(r.tradePnl)}">\${sg(r.tradePnl)}</div></div>
        <div><div class="k">收益率</div><div class="v \${cls(r.roiPct)}">\${sg(r.roiPct)}%</div></div>
        <div><div class="k">已平仓量 (\${esc(base(r.symbol))})</div><div class="v">\${n(r.closedQty, 4)}</div></div>
        <div><div class="k">开仓价格</div><div class="v">\${px(r.openAvg)}</div></div>
        <div><div class="k">平仓均价</div><div class="v">\${px(r.closeAvg)}</div></div>
        <div><div class="k">最大未平仓合约量</div><div class="v">\${n(r.maxQty, 4)}</div></div>
        <div><div class="k">手续费 / 资金费</div><div class="v">\${n(r.quoteFees)} / <span class="\${cls(r.funding)}">\${sg(r.funding)}</span></div></div>
        <div><div class="k">净盈亏</div><div class="v \${cls(r.net)}">\${sg(r.net)}</div></div>
        <div><div class="k">成交笔数</div><div class="v">\${r.fillCount}</div></div>
      </div>
    </div>\`).join('');
  return summary + '<table><thead><tr>' + th('history','symbol','合约',true) + th('history','tradePnl','已实现盈亏') + th('history','roiPct','收益率') + th('history','closedQty','已平仓量') + th('history','openAvg','开仓价格') + th('history','closeAvg','平仓均价') + th('history','maxQty','最大未平仓量') + th('history','quoteFees','手续费') + th('history','funding','资金费') + th('history','net','净盈亏') + th('history','fillCount','成交') + th('history','openedAt','开仓时间') + th('history','closedAt','最后平仓时间') + '</tr></thead><tbody>' +
    rows.map(r => '<tr><td class="l"><span class="sym">' + esc(r.symbol) + '</span>' + (r.leverage ? '<span class="pill">' + r.leverage + 'x</span>' : '') + side(r) + (r.closedAt ? '' : '<span class="pill">持仓中</span>') + (r.truncated ? '<span class="pill">区间前开仓</span>' : '') + '</td>' +
      '<td class="' + cls(r.tradePnl) + '">' + sg(r.tradePnl) + '</td><td class="' + cls(r.roiPct) + '">' + sg(r.roiPct) + '%</td><td>' + n(r.closedQty, 4) + '</td><td>' + px(r.openAvg) + '</td><td>' + px(r.closeAvg) + '</td><td>' + n(r.maxQty, 4) + '</td><td>' + n(r.quoteFees) + '</td><td class="' + cls(r.funding) + '">' + sg(r.funding) + '</td><td class="' + cls(r.net) + '">' + sg(r.net) + '</td><td>' + r.fillCount + '</td><td>' + (r.truncated ? '区间前' : fmtT(r.openedAt)) + '</td><td>' + (r.closedAt ? fmtT(r.closedAt) : '—') + '</td></tr>').join('') + '</tbody></table>';
}

function renderFills() {
  const all = R.fills.filter(r => match(r.symbol) && inRange(r.time));
  const rows = sortRows(all, 'fills', 'time', 'desc');
  $('#n-fills').textContent = '(' + R.fills.length + ')';
  if (!rows.length) return '<div class="empty">区间内没有成交</div>';
  return '<table><thead><tr>' + th('fills','time','时间',true) + th('fills','symbol','合约',true) + th('fills','side','方向',true) + th('fills','price','价格') + th('fills','qty','数量') + th('fills','quoteQty','成交额') + th('fills','fee','手续费') + th('fills','realizedPnl','已实现盈亏') + th('fills','maker','Maker',true) + th('fills','orderId','订单号',true) + '</tr></thead><tbody>' +
    rows.map(r => '<tr><td class="l">' + fmtT(r.time) + '</td><td class="l sym">' + esc(r.symbol) + (R.hedged ? '<span class="pill">' + r.positionSide + '</span>' : '') + '</td><td class="l ' + (r.side === 'buy' ? 'up' : 'down') + '">' + (r.side === 'buy' ? '买入' : '卖出') + '</td><td>' + px(r.price) + '</td><td>' + n(r.qty, 4) + '</td><td>' + n(r.quoteQty) + '</td><td>' + (r.fee !== undefined ? n(r.fee, 6) + ' ' + esc(r.feeAsset || '') : '—') + '</td><td class="' + cls(r.realizedPnl) + '">' + (r.realizedPnl !== undefined ? sg(r.realizedPnl, 4) : '—') + '</td><td class="l">' + (r.maker === undefined ? '—' : r.maker ? '是' : '否') + '</td><td class="l">' + esc(r.orderId) + '</td></tr>').join('') + '</tbody></table>';
}

function renderFunding() {
  const all = R.funding.filter(r => match(r.symbol) && inRange(r.timestamp));
  const rows = sortRows(all, 'funding', 'timestamp', 'desc');
  $('#n-funding').textContent = '(' + R.funding.length + ')';
  if (!rows.length) return '<div class="empty">区间内没有资金费记录</div>';
  const sum = all.reduce((s, r) => s + r.amount, 0);
  return '<div class="totals"><span>筛选合计 <b class="' + cls(sum) + '">' + sg(sum, 4) + '</b></span></div><table><thead><tr>' + th('funding','timestamp','时间',true) + th('funding','symbol','合约',true) + th('funding','amount','金额') + th('funding','asset','资产',true) + th('funding','attributed','归属',true) + '</tr></thead><tbody>' +
    rows.map(r => '<tr><td class="l">' + fmtT(r.timestamp) + '</td><td class="l sym">' + esc(r.symbol) + '</td><td class="' + cls(r.amount) + '">' + sg(r.amount, 6) + '</td><td class="l">' + esc(r.asset) + '</td><td class="l">' + (r.attributed ? '已计入仓位' : '<span class="pill">无对应仓位</span>') + '</td></tr>').join('') + '</tbody></table>';
}

// ── Equity curve: 0 at the first fill, then every fill's realized PnL and
// every funding payment, in time order. Three readings of the same walk.
const chart = { x0: null, x1: null, pts: [], drag: null, dirty: true };
function curveSeries() {
  const ev = [];
  for (const f of R.fills) if (match(f.symbol) && inRange(f.time)) ev.push({ t: f.time, trade: f.realizedPnl || 0, fee: f.feeAsset === quote(f.symbol) ? (f.fee || 0) : 0, fund: 0, sym: f.symbol, kind: 'fill', side: f.side, qty: f.qty, price: f.price });
  for (const u of R.funding) if (match(u.symbol) && inRange(u.timestamp)) ev.push({ t: u.timestamp, trade: 0, fee: 0, fund: u.amount, sym: u.symbol, kind: 'funding' });
  ev.sort((a, b) => a.t - b.t);
  const pts = [];
  if (ev.length) pts.push({ t: ev[0].t, trade: 0, afterFee: 0, net: 0, e: null });
  let a = 0, b = 0, c = 0;
  for (const e of ev) { a += e.trade; b += e.trade - e.fee; c += e.trade - e.fee + e.fund; pts.push({ t: e.t, trade: a, afterFee: b, net: c, e }); }
  return pts;
}
function curveStats(pts) {
  if (!pts.length) return '';
  let peak = -Infinity, dd = 0, peakT = 0;
  for (const p of pts) { if (p.net > peak) { peak = p.net; peakT = p.t; } dd = Math.min(dd, p.net - peak); }
  const last = pts[pts.length - 1];
  return '终值 <b class="' + cls(last.net) + '">' + sg(last.net) + '</b> · 峰值 <b class="' + cls(peak) + '">' + sg(peak) + '</b> (' + fmtT(peakT) + ') · 最大回撤 <b class="down">' + n(dd) + '</b> · 事件 <b>' + (pts.length - 1) + '</b>';
}
function drawCurve() {
  const cv = $('#cv'); if (!cv.isConnected || !$('#curve').classList.contains('on')) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const pts = chart.pts; if (pts.length < 2) { g.fillStyle = '#848e9c'; g.font = '13px sans-serif'; g.fillText('区间内没有成交', 20, 30); return; }
  const L = 70, Rm = 16, T = 16, B = 34;
  const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
  const x0 = chart.x0 ?? tMin, x1 = chart.x1 ?? (tMax === tMin ? tMin + 60000 : tMax);
  const show = { trade: $('#s-trade').checked, afterFee: $('#s-fee').checked, net: $('#s-net').checked };
  // y range over the visible window, holding the value from just before it.
  let yMin = 0, yMax = 0, lo = lower(pts, x0); if (lo > 0) lo--;
  for (let i = lo; i < pts.length && pts[i].t <= x1 + (x1 - x0); i++) for (const k of ['trade', 'afterFee', 'net']) if (show[k]) { yMin = Math.min(yMin, pts[i][k]); yMax = Math.max(yMax, pts[i][k]); }
  if (yMax === yMin) { yMax += 1; yMin -= 1; } const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad;
  const X = t => L + (t - x0) / (x1 - x0) * (W - L - Rm), Y = v => T + (yMax - v) / (yMax - yMin) * (H - T - B);
  chart.X = X; chart.Y = Y; chart.x0v = x0; chart.x1v = x1;
  g.font = '11px sans-serif'; g.textBaseline = 'middle';
  // grid
  const ySteps = 6; g.strokeStyle = '#2b3139'; g.fillStyle = '#848e9c'; g.textAlign = 'right';
  for (let i = 0; i <= ySteps; i++) { const v = yMin + (yMax - yMin) * i / ySteps, y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(W - Rm, y); g.stroke(); g.fillText(n(v, Math.abs(yMax - yMin) < 10 ? 2 : 0), L - 6, y); }
  const span = x1 - x0, xSteps = Math.max(2, Math.floor((W - L - Rm) / 110)); g.textAlign = 'center'; g.textBaseline = 'top';
  for (let i = 0; i <= xSteps; i++) { const t = x0 + span * i / xSteps, x = X(t); g.beginPath(); g.moveTo(x, T); g.lineTo(x, H - B); g.stroke(); const s = fmtT(t); g.fillText(span > 2 * 86400000 ? s.slice(0, 10) : s.slice(5, 16), x, H - B + 6); }
  // zero line
  if (yMin < 0 && yMax > 0) { g.strokeStyle = '#555'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(W - Rm, Y(0)); g.stroke(); g.setLineDash([]); }
  g.save(); g.beginPath(); g.rect(L, T, W - L - Rm, H - T - B); g.clip();
  const colors = { trade: '#848e9c', afterFee: '#f0b90b', net: '#0ecb81' };
  for (const k of ['trade', 'afterFee', 'net']) {
    if (!show[k]) continue;
    g.strokeStyle = colors[k]; g.lineWidth = k === 'net' ? 1.6 : 1; g.beginPath();
    let started = false, lastX = -1;
    for (let i = lo; i < pts.length; i++) {
      const p = pts[i]; if (p.t > x1 && started) { g.lineTo(X(p.t), Y(pts[i - 1][k])); g.lineTo(X(p.t), Y(p[k])); break; }
      const x = X(p.t), y = Y(p[k]);
      if (!started) { g.moveTo(x, y); started = true; } else { if (i > lo) g.lineTo(x, Y(pts[i - 1][k])); g.lineTo(x, y); }
      lastX = x;
    }
    g.stroke();
  }
  g.restore();
  // legend
  g.textAlign = 'left'; g.textBaseline = 'middle'; let lx = L + 8;
  for (const [k, label] of [['trade', '交易盈亏'], ['afterFee', '扣手续费'], ['net', '净值']]) { if (!show[k]) continue; g.fillStyle = colors[k]; g.fillRect(lx, T + 4, 10, 3); g.fillStyle = '#eaecef'; g.fillText(label, lx + 14, T + 6); lx += 14 + g.measureText(label).width + 16; }
}
function lower(pts, t) { let a = 0, b = pts.length; while (a < b) { const m = (a + b) >> 1; if (pts[m].t < t) a = m + 1; else b = m; } return a; }
function renderCurve() {
  chart.pts = curveSeries();
  $('#n-curve').textContent = '(' + Math.max(0, chart.pts.length - 1) + ')';
  $('#curve-stats').innerHTML = curveStats(chart.pts);
  drawCurve();
}
(() => {
  const cv = $('#cv'), tip = $('#tip');
  const clampView = () => { const p = chart.pts; if (!p.length) return; const a = p[0].t, b = p[p.length - 1].t; const w = chart.x1 - chart.x0; if (chart.x0 < a) { chart.x0 = a; chart.x1 = a + w; } if (chart.x1 > b) { chart.x1 = b; chart.x0 = Math.max(a, b - w); } };
  cv.addEventListener('wheel', e => {
    e.preventDefault(); if (!chart.X) return;
    const rect = cv.getBoundingClientRect(), mx = e.clientX - rect.left;
    const x0 = chart.x0v, x1 = chart.x1v, t = x0 + (mx - 70) / (cv.clientWidth - 70 - 16) * (x1 - x0);
    const k = e.deltaY > 0 ? 1.25 : 0.8, span = Math.max(60000, (x1 - x0) * k);
    chart.x0 = t - (t - x0) * k; chart.x1 = chart.x0 + span; clampView(); drawCurve();
  }, { passive: false });
  cv.addEventListener('pointerdown', e => { chart.drag = { x: e.clientX, x0: chart.x0v, x1: chart.x1v }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointerup', () => { chart.drag = null; });
  cv.addEventListener('dblclick', () => { chart.x0 = chart.x1 = null; drawCurve(); });
  cv.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  cv.addEventListener('pointermove', e => {
    if (!chart.X) return;
    const rect = cv.getBoundingClientRect(), mx = e.clientX - rect.left;
    if (chart.drag) { const dt = (e.clientX - chart.drag.x) / (cv.clientWidth - 70 - 16) * (chart.drag.x1 - chart.drag.x0); chart.x0 = chart.drag.x0 - dt; chart.x1 = chart.drag.x1 - dt; clampView(); drawCurve(); return; }
    const t = chart.x0v + (mx - 70) / (cv.clientWidth - 70 - 16) * (chart.x1v - chart.x0v);
    const pts = chart.pts; if (pts.length < 2) return;
    let i = lower(pts, t); if (i >= pts.length) i = pts.length - 1; if (i > 0 && t - pts[i - 1].t < pts[i].t - t) i--;
    const p = pts[i], ev = p.e;
    tip.innerHTML = fmtT(p.t) + '<br>净值 <b class="' + cls(p.net) + '">' + sg(p.net) + '</b> · 扣费 ' + sg(p.afterFee) + ' · 交易 ' + sg(p.trade) +
      (ev ? '<br>' + esc(ev.sym) + (ev.kind === 'fill' ? ' ' + (ev.side === 'buy' ? '买' : '卖') + ' ' + n(ev.qty, 4) + ' @ ' + px(ev.price) + ' 盈亏 ' + sg(ev.trade, 4) + (ev.fee ? ' 费 ' + n(ev.fee, 4) : '') : ' 资金费 ' + sg(ev.fund, 4)) : '<br>起点');
    tip.style.display = 'block';
    const tx = Math.min(mx + 14, cv.clientWidth - tip.offsetWidth - 8), ty = Math.max(0, e.clientY - rect.top - tip.offsetHeight - 12);
    tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
  });
  for (const id of ['s-trade', 's-fee', 's-net']) $('#' + id).addEventListener('change', drawCurve);
  window.addEventListener('resize', drawCurve);
})();

function render() {
  for (const el of document.querySelectorAll('.tab')) el.classList.toggle('on', el.dataset.view === state.view);
  for (const el of document.querySelectorAll('.view')) el.classList.toggle('on', el.id === state.view);
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = fmtT(Number(el.dataset.t));
  $('#positions').innerHTML = renderPositions();
  $('#history').innerHTML = renderHistory();
  $('#fills').innerHTML = renderFills();
  $('#funding').innerHTML = renderFunding();
  renderCurve();
}
document.addEventListener('toggle', e => { if (e.target.id === 'history-sum') state.sumOpen = e.target.open; }, true);
document.addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (tab) { state.view = tab.dataset.view; render(); return; }
  const h = e.target.closest('th[data-key]');
  if (h) {
    const cur = state.sort[h.dataset.view];
    state.sort[h.dataset.view] = { key: h.dataset.key, dir: cur && cur.key === h.dataset.key && cur.dir === 'desc' ? 'asc' : 'desc' };
    render();
  }
});
$('#q').addEventListener('input', e => { state.q = e.target.value.trim(); render(); });
$('#from').addEventListener('change', e => { state.from = e.target.value; render(); });
$('#to').addEventListener('change', e => { state.to = e.target.value; render(); });
$('#tz').addEventListener('change', e => { state.tz = e.target.value; try { localStorage.setItem('ow.tz', state.tz); } catch {} render(); });
$('#style').addEventListener('change', e => { state.style = e.target.value; try { localStorage.setItem('ow.style', state.style); } catch {} render(); });
render();
</script>
</body>
</html>`
}

function cls(v: number): string {
  return v > 0 ? 'up' : v < 0 ? 'down' : ''
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c))
}

