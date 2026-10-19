import { z } from 'zod'
import { reportPage, esc, reportStamp, cls as tone, type AccountView, type ScriptDefinition } from '@openwhaleorg/core'
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
  /** Quote traded over the episode, both directions. */
  volumeUsd: number
  /** Largest exposure, at the opening average. */
  maxNotional: number
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
        tradePnl: e.tradePnl, volumeUsd: e.volume, maxNotional: e.maxQty * (e.openAvg > 0 ? e.openAvg : e.closeAvg),
        fees: e.fees, quoteFees, funding: e.funding,
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


/*
 * The report rides on the house shell (`reportPage`): same palette, type and
 * tables as every other report, so the reader is not handed a Binance
 * look-alike. The layout is still Binance's — the four tabs, the per-row
 * fields — because that is what the reader compares it against.
 *
 * Styles below only cover what the shell has no word for: tabs, the filter
 * bar, the column picker, cards, and the canvas chart. Everything else is the
 * shell's class names, so a change there carries here.
 */
const REPORT_CSS = `<style>
.ah-tabs{display:flex;flex-wrap:wrap;gap:2px;border-bottom:1px solid var(--rule);margin:0 0 14px}
.ah-tabs .tab{font-family:var(--f-sans);font-size:13px;color:var(--ink-3);padding:8px 12px;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer;user-select:none}
.ah-tabs .tab:hover{color:var(--ink)}
.ah-tabs .tab.on{color:var(--ink);border-bottom-color:var(--accent)}
.ah-tabs .tab small{font-family:var(--f-mono);font-size:11px;color:var(--ink-3);margin-left:5px}
.ah-bar{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:0 0 14px;font-family:var(--f-sans);font-size:12.5px;color:var(--ink-3)}
.ah-bar input,.ah-bar select,.ah-bar button{font-family:var(--f-sans);font-size:12.5px;color:var(--ink);background:var(--surface);border:1px solid var(--rule);border-radius:2px;padding:3px 8px}
.ah-bar button{cursor:pointer;color:var(--ink-2)}
.ah-bar button:hover{border-color:var(--accent)}
.ah-bar input:focus,.ah-bar select:focus{outline:none;border-color:var(--accent)}
.view{display:none}.view.on{display:block}
.tag{display:inline-block;font-family:var(--f-mono);font-size:10.5px;color:var(--ink-3);background:var(--surface-2);border:1px solid var(--rule);border-radius:2px;padding:0 5px;margin-left:6px;vertical-align:1px}
.tag.long{color:var(--gain);border-color:var(--gain)}
.tag.short{color:var(--loss);border-color:var(--loss)}
.sym{font-weight:600}
th[data-key]{cursor:pointer}
th[draggable]{cursor:grab}
th.dragover{box-shadow:inset 2px 0 0 var(--accent)}
th.sorted{color:var(--accent)}
th.sorted::after{content:" ▾"}
th.sorted.asc::after{content:" ▴"}
.pop{display:none;position:absolute;top:30px;left:0;z-index:5;background:var(--surface);border:1px solid var(--rule-2);padding:8px 12px;min-width:220px;box-shadow:0 6px 24px rgba(0,0,0,.18);font-family:var(--f-sans);font-size:12.5px;color:var(--ink)}
.pop.on{display:block}
.pop label{display:block;padding:2px 0;cursor:pointer;white-space:nowrap}
.pop .pophead{color:var(--ink-3);font-size:11px;padding-bottom:6px;border-bottom:1px solid var(--rule);margin-bottom:6px}
.pop a{color:var(--accent);float:right;text-decoration:none}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:10px;margin:0 0 8px}
.card{background:var(--surface);border:1px solid var(--rule);padding:12px 14px}
.card .head{display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;font-family:var(--f-sans);font-size:13px}
.card .when{color:var(--ink-3);font-family:var(--f-mono);font-size:11.5px}
.card .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px 16px;margin-top:10px}
.card .k{font-family:var(--f-sans);font-size:11px;color:var(--ink-3)}
.card .v{font-family:var(--f-mono);font-size:13px;font-variant-numeric:tabular-nums}
details.sum{margin:0 0 14px}
details.sum summary{cursor:pointer;font-family:var(--f-sans);font-size:12.5px;color:var(--ink-2);padding:4px 0 8px}
.subtotal{font-family:var(--f-sans);font-size:12.5px;color:var(--ink-3);margin:0 0 8px}
.subtotal b,.stats b{font-family:var(--f-mono);font-weight:600;color:var(--ink)}
.subtotal b.pos,.stats b.pos{color:var(--gain)}
.subtotal b.neg,.stats b.neg{color:var(--loss)}
.keys .hint{font-family:var(--f-sans);font-size:12px;color:var(--ink-3)}
.chartwrap{position:relative}
#cv{width:100%;height:460px;display:block;cursor:crosshair;touch-action:none}
.tip{position:absolute;pointer-events:none;display:none;background:var(--surface);border:1px solid var(--rule-2);padding:6px 8px;font-family:var(--f-mono);font-size:11.5px;color:var(--ink);white-space:nowrap;z-index:2;box-shadow:0 4px 16px rgba(0,0,0,.18)}
.stats{font-family:var(--f-sans);font-size:12.5px;color:var(--ink-3);margin:6px 0 0}
</style>`

export function renderHtml(report: Report): string {
  const data = JSON.stringify({ ...report, fills: [], fillCols: compactFills(report.fills) }).replace(/</g, '\\u003c')
  const money = (v: number) => `${v >= 0 ? '+' : ''}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  const plain = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const t = report.totals
  const otherFees = Object.entries(t.otherFees).map(([a, v]) => `${plain(v, 6)} ${a}`).join(', ')

  const body = `${REPORT_CSS}
<p class="ident"><span>区间 ${reportStamp(report.from)} → ${reportStamp(report.to)}</span><span>生成于 ${reportStamp(report.generatedAt)}</span></p>
${report.complete ? '' : `<p class="alarm">数据不完整：${report.notes.map(esc).join('；')}</p>`}
<p class="dim">仓位历史由区间内的成交重建：净数量离开 0 为开仓、回到 0 为平仓，中间的加减仓同属一段；双向持仓模式下 LONG 与 SHORT 各自成账。已实现盈亏取交易所在每笔平仓成交上回报的数字（不含手续费），资金费按结算时刻归入当时持有该合约的那段仓位。收益率 = 已实现盈亏 × 杠杆 ÷ (开仓均价 × 最大持仓量)，杠杆取该合约当前的配置值。</p>
<div class="ah-tabs">
  <span class="tab on" data-view="positions">仓位<small id="n-positions"></small></span>
  <span class="tab" data-view="history">仓位历史<small id="n-history"></small></span>
  <span class="tab" data-view="fills">历史成交<small id="n-fills"></small></span>
  <span class="tab" data-view="funding">资金费用<small id="n-funding"></small></span>
  <span class="tab" data-view="curve">收益曲线<small id="n-curve"></small></span>
</div>
<div class="ah-bar">
  <label>合约 <input id="q" placeholder="筛选，如 SOXS" size="16"></label>
  <label>时间 <select id="from"><option value="">区间起点</option></select> → <select id="to"><option value="">区间终点</option></select></label>
  <label>风格 <select id="style"><option value="table">表格</option><option value="cards">卡片</option></select></label>
  <span style="position:relative"><button id="colbtn">字段</button><div id="colpick" class="pop"></div></span>
</div>
<div id="positions" class="view on"></div>
<div id="history" class="view"></div>
<div id="fills" class="view"></div>
<div id="funding" class="view"></div>
<div id="curve" class="view">
  <div class="keys">
    <button data-key="trade"><i style="color:var(--ink-3)"></i>交易盈亏</button>
    <button data-key="afterFee"><i style="color:var(--warn)"></i>扣手续费</button>
    <button data-key="net"><i style="color:var(--accent)"></i>净值（含资金费）</button>
    <span class="hint">滚轮缩放 · 拖动平移 · 双击复原</span>
  </div>
  <div class="chart chartwrap"><canvas id="cv"></canvas><div id="tip" class="tip"></div></div>
  <p class="stats" id="curve-stats"></p>
</div>`

  const script = `
const R = ${data};
(() => {
  const c = R.fillCols, ps = ['BOTH', 'LONG', 'SHORT'];
  R.fills = c.rows.map(r => ({ id: r[0], orderId: r[1], time: r[2], symbol: c.symbols[r[3]], side: r[4] ? 'sell' : 'buy', positionSide: ps[r[5]],
    qty: r[6], price: r[7], quoteQty: r[6] * r[7], realizedPnl: r[8] === null ? undefined : r[8], fee: r[9] === null ? undefined : r[9],
    feeAsset: r[10] < 0 ? undefined : c.feeAssets[r[10]], maker: r[11] < 0 ? undefined : r[11] === 1 }));
})();
const $ = s => document.querySelector(s);
const state = { view: 'positions', q: '', style: 'table', from: '', to: '', sort: {} };
try { state.style = localStorage.getItem('ow.style') || 'table'; } catch {}
$('#style').value = state.style;
// A deep link: #history, #curve … opens on that tab.
if (/^#(positions|history|fills|funding|curve)$/.test(location.hash)) state.view = location.hash.slice(1);

// Timestamps follow the shell's UTC / local switch; the shell announces a
// change and the tables are redrawn in whichever zone it now says.
const fmtT = ms => (ms === undefined || ms === null || !isFinite(ms)) ? '—' : (window.owTz ? window.owTz.fmt(ms) : new Date(ms).toISOString().slice(5, 23).replace('T', ' '));
const fmtS = ms => fmtT(ms).slice(0, 14);
const n = (v, d=2) => (v === undefined || v === null || !isFinite(v)) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const sg = (v, d=2) => (v === undefined || v === null || !isFinite(v)) ? '—' : (v >= 0 ? '+' : '') + n(v, d);
const cls = v => (v > 0 ? 'pos' : v < 0 ? 'neg' : '');
const px = v => n(v, v >= 100 ? 2 : v >= 1 ? 4 : 6);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const base = s => s.split('/')[0];
const quote = s => (s.split(':')[1] || s.split('/')[1] || 'USDT');
const tag = (s, k) => '<span class="tag' + (k ? ' ' + k : '') + '">' + s + '</span>';
const side = r => tag(r.direction === 'long' ? '做多' : '做空', r.direction);
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

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
  return '<th class="' + (left ? 'l ' : '') + (on ? 'sorted ' + s.dir : '') + '" data-view="' + view + '" data-key="' + key + '"' + (COLS[view] ? ' draggable="true"' : '') + '>' + label + '</th>';
}
const wrap = (inner, slim) => '<div class="tblwrap"><table' + (slim ? ' class="slim"' : '') + '>' + inner + '</table></div>';

// ── Tables: columns the reader can reorder (drag a header) and show or hide
// (the 字段 button). Kept per table in this browser.
const sym = r => '<span class="sym">' + esc(r.symbol) + '</span>';
const money = (k, d = 2) => ({ r: r => sg(r[k], d), cls: r => cls(r[k]) });
const COLS = {
  positions: [
    { k: 'symbol', l: '合约', left: true, r: r => sym(r) + tag(r.leverage + 'x') + tag(r.marginMode === 'isolated' ? '逐仓' : '全仓') + side(r) },
    { k: 'qty', l: '数量', r: r => n(r.qty, 4) },
    { k: 'notional', l: '名义价值', r: r => n(r.notional) },
    { k: 'entryPrice', l: '开仓价格', r: r => px(r.entryPrice) },
    { k: 'breakEvenPrice', l: '损益两平价', r: r => r.breakEvenPrice ? px(r.breakEvenPrice) : '—' },
    { k: 'markPrice', l: '标记价格', r: r => px(r.markPrice) },
    { k: 'liquidationPrice', l: '强平价格', r: r => r.liquidationPrice ? px(r.liquidationPrice) : '—' },
    { k: 'margin', l: '保证金', r: r => n(r.margin) },
    { k: 'unrealizedPnl', l: '未实现盈亏', ...money('unrealizedPnl') },
    { k: 'roiPct', l: '回报率', r: r => sg(r.roiPct) + '%', cls: r => cls(r.roiPct) },
    { k: 'realizedSoFar', l: '本仓已实现', ...money('realizedSoFar') },
    { k: 'feesSoFar', l: '本仓手续费', r: r => n(r.feesSoFar), hide: true },
    { k: 'fundingSoFar', l: '本仓资金费', ...money('fundingSoFar') },
    { k: 'openedAt', l: '开仓时间', r: r => r.openedAt ? fmtS(r.openedAt) : '区间前' },
    { k: 'updateTime', l: '最后更新', r: r => fmtS(r.updateTime), hide: true },
  ],
  history: [
    { k: 'symbol', l: '合约', left: true, r: r => sym(r) + (r.leverage ? tag(r.leverage + 'x') : '') + side(r) + (r.closedAt ? '' : tag('持仓中')) + (r.truncated ? tag('区间前开仓') : '') },
    { k: 'tradePnl', l: '已实现盈亏', ...money('tradePnl') },
    { k: 'roiPct', l: '收益率', r: r => sg(r.roiPct) + '%', cls: r => cls(r.roiPct) },
    { k: 'closedQty', l: '已平仓量', r: r => n(r.closedQty, 4) },
    { k: 'openAvg', l: '开仓价格', r: r => px(r.openAvg) },
    { k: 'closeAvg', l: '平仓均价', r: r => px(r.closeAvg) },
    { k: 'maxQty', l: '最大未平仓量', r: r => n(r.maxQty, 4) },
    { k: 'maxNotional', l: '最大名义 (USD)', r: r => n(r.maxNotional) },
    { k: 'volumeUsd', l: '交易量 (USD)', r: r => n(r.volumeUsd) },
    { k: 'quoteFees', l: '手续费', r: r => n(r.quoteFees) },
    { k: 'funding', l: '资金费', ...money('funding') },
    { k: 'net', l: '净盈亏', ...money('net') },
    { k: 'fillCount', l: '成交', r: r => r.fillCount },
    { k: 'positionSide', l: '持仓方向', left: true, r: r => r.positionSide, hide: true },
    { k: 'openedAt', l: '开仓时间', r: r => r.truncated ? '区间前' : fmtS(r.openedAt) },
    { k: 'closedAt', l: '最后平仓时间', r: r => r.closedAt ? fmtS(r.closedAt) : '—' },
  ],
  fills: [
    { k: 'time', l: '时间', left: true, r: r => fmtT(r.time) },
    { k: 'symbol', l: '合约', left: true, r: r => sym(r) },
    { k: 'positionSide', l: '持仓方向', left: true, r: r => r.positionSide, hide: !R.hedged },
    { k: 'side', l: '方向', left: true, r: r => r.side === 'buy' ? '买入' : '卖出', cls: r => r.side === 'buy' ? 'pos' : 'neg' },
    { k: 'price', l: '价格', r: r => px(r.price) },
    { k: 'qty', l: '数量', r: r => n(r.qty, 4) },
    { k: 'quoteQty', l: '成交额', r: r => n(r.quoteQty) },
    { k: 'fee', l: '手续费', r: r => r.fee !== undefined ? n(r.fee, 6) + ' ' + esc(r.feeAsset || '') : '—' },
    { k: 'realizedPnl', l: '已实现盈亏', r: r => r.realizedPnl !== undefined ? sg(r.realizedPnl, 4) : '—', cls: r => cls(r.realizedPnl) },
    { k: 'maker', l: 'Maker', left: true, r: r => r.maker === undefined ? '—' : r.maker ? '是' : '否' },
    { k: 'orderId', l: '订单号', left: true, r: r => esc(r.orderId) },
    { k: 'id', l: '成交号', left: true, r: r => esc(r.id), hide: true },
  ],
  funding: [
    { k: 'timestamp', l: '时间', left: true, r: r => fmtS(r.timestamp) },
    { k: 'symbol', l: '合约', left: true, r: r => sym(r) },
    { k: 'amount', l: '金额', r: r => sg(r.amount, 6), cls: r => cls(r.amount) },
    { k: 'asset', l: '资产', left: true, r: r => esc(r.asset) },
    { k: 'attributed', l: '归属', left: true, r: r => r.attributed ? '已计入仓位' : tag('无对应仓位') },
  ],
};
state.cols = {};
function colState(view) {
  let st = state.cols[view];
  if (st) return st;
  const defs = COLS[view];
  st = { order: defs.map(c => c.k), hidden: defs.filter(c => c.hide).map(c => c.k) };
  try {
    const saved = JSON.parse(localStorage.getItem('ow.cols.' + view));
    if (saved && Array.isArray(saved.order)) {
      st.order = [...saved.order.filter(k => defs.some(c => c.k === k)), ...st.order.filter(k => !saved.order.includes(k))];
      st.hidden = (saved.hidden || []).filter(k => defs.some(c => c.k === k));
    }
  } catch {}
  state.cols[view] = st;
  return st;
}
function saveCols(view) { try { localStorage.setItem('ow.cols.' + view, JSON.stringify(state.cols[view])); } catch {} }
function visibleCols(view) { const st = colState(view), defs = COLS[view]; return st.order.filter(k => !st.hidden.includes(k)).map(k => defs.find(c => c.k === k)); }
function table(view, rows, slim) {
  const cols = visibleCols(view);
  return wrap('<thead><tr>' + cols.map(c => th(view, c.k, c.l, c.left)).join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + cols.map(c => '<td class="' + (c.left ? 'l ' : '') + (c.cls ? c.cls(r) : '') + '">' + c.r(r) + '</td>').join('') + '</tr>').join('') + '</tbody>', slim);
}
function moveCol(view, from, to) {
  const st = colState(view), order = st.order.filter(k => k !== from), at = order.indexOf(to);
  order.splice(at < 0 ? order.length : at, 0, from);
  st.order = order; saveCols(view); render();
}
function renderColPicker() {
  const view = state.view, pick = $('#colpick');
  if (!COLS[view]) { pick.style.display = 'none'; return; }
  const st = colState(view), defs = COLS[view];
  pick.innerHTML = '<div class="pophead">字段 · 拖动表头可调整顺序 <a href="#" id="colreset">重置</a></div>' + st.order.map(k => { const c = defs.find(d => d.k === k); return '<label><input type="checkbox" data-col="' + k + '"' + (st.hidden.includes(k) ? '' : ' checked') + '> ' + c.l + '</label>'; }).join('');
}

function renderPositions() {
  const rows = sortRows(R.positions.filter(r => match(r.symbol)), 'positions', 'notional', 'desc');
  $('#n-positions').textContent = '(' + R.positions.length + ')';
  if (!rows.length) return '<div class="empty">没有持仓</div>';
  if (state.style === 'cards') return '<div class="cards">' + rows.map(r => \`
    <div class="card">
      <div class="head"><div><span class="sym">\${esc(r.symbol)}</span>\${tag('永续 ' + r.leverage + 'x')}\${tag(r.marginMode === 'isolated' ? '逐仓' : '全仓')}\${side(r)}</div>
        <div class="when">\${r.openedAt ? fmtS(r.openedAt) + ' 开仓' : '区间前开仓'}\${r.updateTime ? ' · 最后更新 ' + fmtS(r.updateTime) : ''}</div></div>
      <div class="row">
        <div><div class="k">数量 (\${esc(base(r.symbol))})</div><div class="v">\${n(r.qty, 4)}</div></div>
        <div><div class="k">名义价值</div><div class="v">\${n(r.notional)} \${quote(r.symbol)}</div></div>
        <div><div class="k">开仓价格</div><div class="v">\${px(r.entryPrice)}</div></div>
        <div><div class="k">损益两平价</div><div class="v">\${r.breakEvenPrice ? px(r.breakEvenPrice) : '—'}</div></div>
        <div><div class="k">标记价格</div><div class="v">\${px(r.markPrice)}</div></div>
        <div><div class="k">强平价格</div><div class="v">\${r.liquidationPrice ? px(r.liquidationPrice) : '—'}</div></div>
        <div><div class="k">保证金</div><div class="v">\${n(r.margin)}</div></div>
        <div><div class="k">未实现盈亏 (回报率)</div><div class="v \${cls(r.unrealizedPnl)}">\${sg(r.unrealizedPnl)} (\${sg(r.roiPct)}%)</div></div>
        <div><div class="k">本仓已实现</div><div class="v \${cls(r.realizedSoFar)}">\${sg(r.realizedSoFar)}</div></div>
        <div><div class="k">本仓手续费 / 资金费</div><div class="v">\${n(r.feesSoFar)} / <span class="\${cls(r.fundingSoFar)}">\${sg(r.fundingSoFar)}</span></div></div>
      </div>
    </div>\`).join('') + '</div>';
  return table('positions', rows);
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
    const a = bySym.get(r.symbol) || { symbol: r.symbol, episodes: 0, open: 0, closedQty: 0, volumeUsd: 0, maxNotional: 0, tradePnl: 0, quoteFees: 0, funding: 0, net: 0 };
    a.episodes++; if (!r.closedAt) a.open++; a.closedQty += r.closedQty; a.volumeUsd += r.volumeUsd; a.maxNotional = Math.max(a.maxNotional, r.maxNotional); a.tradePnl += r.tradePnl; a.quoteFees += r.quoteFees; a.funding += r.funding; a.net += r.net;
    bySym.set(r.symbol, a);
  }
  const sums = sortRows([...bySym.values()], 'historySum', 'net', 'desc');
  const summary = '<details class="sum"' + (state.sumOpen ? ' open' : '') + ' id="history-sum"><summary>按合约汇总（' + sums.length + ' 个合约）</summary>' + wrap('<thead><tr>' + th('historySum','symbol','合约',true) + th('historySum','episodes','仓位段') + th('historySum','closedQty','已平仓量') + th('historySum','volumeUsd','交易量 (USD)') + th('historySum','maxNotional','最大名义 (USD)') + th('historySum','tradePnl','已实现盈亏') + th('historySum','quoteFees','手续费') + th('historySum','funding','资金费') + th('historySum','net','净盈亏') + '</tr></thead><tbody>' +
    sums.map(a => '<tr><td class="l sym">' + esc(a.symbol) + '</td><td>' + a.episodes + (a.open ? tag(a.open + ' 持仓中') : '') + '</td><td>' + n(a.closedQty, 4) + '</td><td>' + n(a.volumeUsd) + '</td><td>' + n(a.maxNotional) + '</td><td class="' + cls(a.tradePnl) + '">' + sg(a.tradePnl) + '</td><td>' + n(a.quoteFees) + '</td><td class="' + cls(a.funding) + '">' + sg(a.funding) + '</td><td class="' + cls(a.net) + '">' + sg(a.net) + '</td></tr>').join('') + '</tbody>') + '</details>';
  if (state.style === 'cards') return summary + '<div class="cards">' + rows.map(r => \`
    <div class="card">
      <div class="head"><div><span class="sym">\${esc(r.symbol)}</span>\${tag('永续' + (r.leverage ? ' ' + r.leverage + 'x' : ''))}\${r.marginMode ? tag(r.marginMode === 'isolated' ? '逐仓' : '全仓') : ''}\${side(r)}\${tag(r.closedAt ? '全部平仓' : '持仓中')}\${r.truncated ? tag('区间前开仓') : ''}</div>
        <div class="when">\${r.truncated ? '区间前' : fmtS(r.openedAt)} 开仓 | \${r.closedAt ? fmtS(r.closedAt) + ' 最后平仓' : '未平'}</div></div>
      <div class="row">
        <div><div class="k">已实现盈亏 (\${quote(r.symbol)})</div><div class="v \${cls(r.tradePnl)}">\${sg(r.tradePnl)}</div></div>
        <div><div class="k">收益率</div><div class="v \${cls(r.roiPct)}">\${sg(r.roiPct)}%</div></div>
        <div><div class="k">已平仓量 (\${esc(base(r.symbol))})</div><div class="v">\${n(r.closedQty, 4)}</div></div>
        <div><div class="k">开仓价格</div><div class="v">\${px(r.openAvg)}</div></div>
        <div><div class="k">平仓均价</div><div class="v">\${px(r.closeAvg)}</div></div>
        <div><div class="k">最大未平仓合约量</div><div class="v">\${n(r.maxQty, 4)}</div></div>
        <div><div class="k">最大名义 / 交易量 (USD)</div><div class="v">\${n(r.maxNotional)} / \${n(r.volumeUsd)}</div></div>
        <div><div class="k">手续费 / 资金费</div><div class="v">\${n(r.quoteFees)} / <span class="\${cls(r.funding)}">\${sg(r.funding)}</span></div></div>
        <div><div class="k">净盈亏</div><div class="v \${cls(r.net)}">\${sg(r.net)}</div></div>
        <div><div class="k">成交笔数</div><div class="v">\${r.fillCount}</div></div>
      </div>
    </div>\`).join('') + '</div>';
  return summary + table('history', rows);
}

function renderFills() {
  const all = R.fills.filter(r => match(r.symbol) && inRange(r.time));
  const rows = sortRows(all, 'fills', 'time', 'desc');
  $('#n-fills').textContent = '(' + R.fills.length + ')';
  if (!rows.length) return '<div class="empty">区间内没有成交</div>';
  return table('fills', rows);
}

function renderFunding() {
  const all = R.funding.filter(r => match(r.symbol) && inRange(r.timestamp));
  const rows = sortRows(all, 'funding', 'timestamp', 'desc');
  $('#n-funding').textContent = '(' + R.funding.length + ')';
  if (!rows.length) return '<div class="empty">区间内没有资金费记录</div>';
  const sum = all.reduce((s, r) => s + r.amount, 0);
  return '<p class="subtotal">筛选合计 <b class="' + cls(sum) + '">' + sg(sum, 4) + '</b></p>' + table('funding', rows, true);
}

// ── Equity curve: 0 at the first fill, then every fill's realized PnL and
// every funding payment, in time order. Three readings of the same walk.
const chart = { x0: null, x1: null, pts: [], drag: null, off: {} };
const SERIES = [['trade', '交易盈亏', '--ink-3'], ['afterFee', '扣手续费', '--warn'], ['net', '净值', '--accent']];
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
  return '终值 <b class="' + cls(last.net) + '">' + sg(last.net) + '</b> · 峰值 <b class="' + cls(peak) + '">' + sg(peak) + '</b> (' + fmtS(peakT) + ') · 最大回撤 <b class="neg">' + n(dd) + '</b> · 事件 <b>' + (pts.length - 1) + '</b>';
}
function axisT(t, span) { const s = fmtT(t); return span > 2 * 86400000 ? s.slice(0, 5) : s.slice(0, 11); }
function drawCurve() {
  const cv = $('#cv'); if (!cv.isConnected || !$('#curve').classList.contains('on')) return;
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const mono = '11px ' + css('--f-mono'), ink = css('--ink'), ink3 = css('--ink-3'), rule = css('--rule'), rule2 = css('--rule-2');
  const pts = chart.pts; if (pts.length < 2) { g.fillStyle = ink3; g.font = '13px ' + css('--f-sans'); g.fillText('区间内没有成交', 20, 30); return; }
  const L = 70, Rm = 16, T = 16, B = 34;
  const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
  const x0 = chart.x0 ?? tMin, x1 = chart.x1 ?? (tMax === tMin ? tMin + 60000 : tMax);
  const show = {}; for (const [k] of SERIES) show[k] = !chart.off[k];
  // y range over the visible window, holding the value from just before it.
  let yMin = 0, yMax = 0, lo = lower(pts, x0); if (lo > 0) lo--;
  for (let i = lo; i < pts.length && pts[i].t <= x1 + (x1 - x0); i++) for (const [k] of SERIES) if (show[k]) { yMin = Math.min(yMin, pts[i][k]); yMax = Math.max(yMax, pts[i][k]); }
  if (yMax === yMin) { yMax += 1; yMin -= 1; } const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad;
  const X = t => L + (t - x0) / (x1 - x0) * (W - L - Rm), Y = v => T + (yMax - v) / (yMax - yMin) * (H - T - B);
  chart.X = X; chart.Y = Y; chart.x0v = x0; chart.x1v = x1;
  g.font = mono; g.textBaseline = 'middle';
  // grid
  const ySteps = 6; g.strokeStyle = rule; g.fillStyle = ink3; g.textAlign = 'right';
  for (let i = 0; i <= ySteps; i++) { const v = yMin + (yMax - yMin) * i / ySteps, y = Y(v); g.beginPath(); g.moveTo(L, y); g.lineTo(W - Rm, y); g.stroke(); g.fillText(n(v, Math.abs(yMax - yMin) < 10 ? 2 : 0), L - 6, y); }
  const span = x1 - x0, xSteps = Math.max(2, Math.floor((W - L - Rm) / 110)); g.textAlign = 'center'; g.textBaseline = 'top';
  for (let i = 0; i <= xSteps; i++) { const t = x0 + span * i / xSteps, x = X(t); g.beginPath(); g.moveTo(x, T); g.lineTo(x, H - B); g.stroke(); g.fillText(axisT(t, span), x, H - B + 6); }
  // zero line
  if (yMin < 0 && yMax > 0) { g.strokeStyle = rule2; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(L, Y(0)); g.lineTo(W - Rm, Y(0)); g.stroke(); g.setLineDash([]); }
  g.save(); g.beginPath(); g.rect(L, T, W - L - Rm, H - T - B); g.clip();
  for (const [k, , color] of SERIES) {
    if (!show[k]) continue;
    g.strokeStyle = css(color); g.lineWidth = k === 'net' ? 1.7 : 1; g.lineJoin = 'round'; g.beginPath();
    let started = false;
    for (let i = lo; i < pts.length; i++) {
      const p = pts[i]; if (p.t > x1 && started) { g.lineTo(X(p.t), Y(pts[i - 1][k])); g.lineTo(X(p.t), Y(p[k])); break; }
      const x = X(p.t), y = Y(p[k]);
      if (!started) { g.moveTo(x, y); started = true; } else { if (i > lo) g.lineTo(x, Y(pts[i - 1][k])); g.lineTo(x, y); }
    }
    g.stroke();
  }
  g.restore();
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
  for (const b of document.querySelectorAll('#curve .keys button[data-key]')) b.addEventListener('click', () => { chart.off[b.dataset.key] = !chart.off[b.dataset.key]; b.classList.toggle('off', !!chart.off[b.dataset.key]); drawCurve(); });
  window.addEventListener('resize', drawCurve);
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawCurve);
})();

function render() {
  for (const el of document.querySelectorAll('.ah-tabs .tab')) el.classList.toggle('on', el.dataset.view === state.view);
  for (const el of document.querySelectorAll('.view')) el.classList.toggle('on', el.id === state.view);
  $('#positions').innerHTML = renderPositions();
  $('#history').innerHTML = renderHistory();
  $('#fills').innerHTML = renderFills();
  $('#funding').innerHTML = renderFunding();
  $('#colbtn').style.display = COLS[state.view] ? '' : 'none';
  $('#style').parentElement.style.display = state.view === 'positions' || state.view === 'history' ? '' : 'none';
  renderCurve();
}
document.addEventListener('toggle', e => { if (e.target.id === 'history-sum') state.sumOpen = e.target.open; }, true);
let dragKey = null;
document.addEventListener('dragstart', e => { const h = e.target.closest && e.target.closest('th[draggable]'); if (!h) return; dragKey = { view: h.dataset.view, key: h.dataset.key }; e.dataTransfer.effectAllowed = 'move'; });
document.addEventListener('dragover', e => { const h = e.target.closest && e.target.closest('th[draggable]'); if (!h || !dragKey || h.dataset.view !== dragKey.view) return; e.preventDefault(); h.classList.add('dragover'); });
document.addEventListener('dragleave', e => { const h = e.target.closest && e.target.closest('th[draggable]'); if (h) h.classList.remove('dragover'); });
document.addEventListener('drop', e => { const h = e.target.closest && e.target.closest('th[draggable]'); if (!h || !dragKey || h.dataset.view !== dragKey.view) return; e.preventDefault(); if (h.dataset.key !== dragKey.key) moveCol(dragKey.view, dragKey.key, h.dataset.key); dragKey = null; });
$('#colbtn').addEventListener('click', e => { e.stopPropagation(); renderColPicker(); $('#colpick').classList.toggle('on'); });
$('#colpick').addEventListener('click', e => e.stopPropagation());
$('#colpick').addEventListener('change', e => { const k = e.target.dataset.col; if (!k) return; const st = colState(state.view); st.hidden = e.target.checked ? st.hidden.filter(x => x !== k) : [...st.hidden, k]; saveCols(state.view); render(); });
document.addEventListener('click', e => { if (e.target.id === 'colreset') { e.preventDefault(); delete state.cols[state.view]; try { localStorage.removeItem('ow.cols.' + state.view); } catch {} renderColPicker(); render(); return; } $('#colpick').classList.remove('on'); });
document.addEventListener('click', e => {
  const tab = e.target.closest('.ah-tabs .tab');
  if (tab) { state.view = tab.dataset.view; try { history.replaceState(null, '', '#' + state.view); } catch {} render(); return; }
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
$('#style').addEventListener('change', e => { state.style = e.target.value; try { localStorage.setItem('ow.style', state.style); } catch {} render(); });
window.addEventListener('owtzchange', render);
render();
`

  return reportPage({
    title: `${report.account} · 账户交易历史`,
    eyebrow: 'binance / account-history',
    h1: `${report.account} 的交易历史`,
    lede: `账户 ${report.account} 在 ${day(report.from)} → ${day(report.to)} 的 ${plain(t.fills, 0)} 笔成交，`
      + `重建为 ${plain(report.history.length, 0)} 段仓位（${plain(t.closedEpisodes, 0)} 段已平），现持 ${t.openPositions} 个仓位。`
      + `四个标签页与币安的仓位、仓位历史、历史成交、资金费用页一一对应，收益曲线从第一笔成交起以 0 计。`,
    ident: [report.account, report.unified ? '统一账户' : '经典账户', report.hedged ? '双向持仓' : '单向持仓',
      `${day(report.from)} → ${day(report.to)}`, `${report.symbols.length} 个合约`],
    figures: [
      { k: '已实现盈亏', v: money(t.tradePnl), n: `${plain(t.closedEpisodes, 0)} 段已平仓位`, cls: tone(t.tradePnl) },
      { k: '手续费', v: `−${plain(t.quoteFees)}`, n: otherFees ? `另有 ${otherFees}` : `${plain(t.fills, 0)} 笔成交`, cls: 'neg' },
      { k: '资金费', v: money(t.funding), n: `${plain(report.funding.length, 0)} 次结算`, cls: tone(t.funding) },
      { k: '净盈亏', v: money(t.net), n: '已实现 − 手续费 + 资金费', cls: tone(t.net) },
      { k: '未实现盈亏', v: money(t.unrealizedPnl), n: `${t.openPositions} 个持仓`, cls: tone(t.unrealizedPnl) },
    ],
    body,
    footer: '成交来自 userTrades（按 7 天分窗拉取），资金费来自 income 账本的 FUNDING_FEE，持仓来自 positionRisk。'
      + '仓位历史由成交重建：净数量离开 0 为开仓、回到 0 为平仓；区间前已开的仓位只记区间内的平仓部分并标「区间前开仓」。'
      + '已实现盈亏为交易所回报的 realizedPnl，不含手续费；手续费只合计计价币种的部分，BNB 等其他资产另列。'
      + '收益率 = 已实现盈亏 × 杠杆 ÷ (开仓均价 × 最大持仓量)，杠杆取合约当前配置。',
    script,
  })
}
