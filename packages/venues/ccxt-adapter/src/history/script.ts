import { z } from 'zod'
import type { AccountView, ScriptDefinition } from '@openwhaleorg/core'
import { collectHistory, isHistorySession, limitsFor, BINANCE_LIMITS, DEFAULT_RANGE_MS, iso, type HistorySession } from './collect.js'
import { renderHtml } from './report.js'

/**
 * One perp account's positions, position history, fills and funding over a
 * range, as Binance's own four tabs plus an equity curve, in one HTML file.
 *
 * Two ways in. The venue's own path is the one that has been measured
 * against the venue's pages — today that is Binance only, and asking for it
 * on another venue is refused with a pointer to the other switch. The ccxt
 * path is the generic one: the shared adapter surface with per-venue limits,
 * for trying the report on any ccxt venue before its own path exists.
 */

/** Venues whose own path exists. Binance's is the generic collector with the Binance adapter's overrides. */
const NATIVE_VENUES = new Set(['binance'])

const paramsSchema = z.object({
  account: z.string().default('').meta({
    displayName: 'Account',
    description: 'A perp account with a bound credential. Leave empty to use the sole ready one.',
    i18n: { 'zh-CN': { displayName: '账户', description: '已绑定凭证的合约账户。留空则使用唯一一个可用账户。' } },
  }),
  useCcxt: z.boolean().default(false).meta({
    displayName: 'Use the ccxt path (testing)',
    description: 'Off: the venue\'s own path — Binance only for now; other venues are refused. On: the generic ccxt path, which works on any ccxt venue but has only been checked against Binance.',
    i18n: { 'zh-CN': { displayName: '使用 ccxt 通用路径（测试）', description: '不勾选走各交易所的原生路径，目前只实现了币安，其他交易所会报错。勾选则走 ccxt 通用路径，任何 ccxt 交易所都能跑，但只在币安上核对过。' } },
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

type Runtime = {
  listAccounts(): Promise<AccountView[]>
  adapters: { resolve<T>(kind: string, type: string, credentialName?: string): Promise<T> }
}

const parseInstant = (raw: string): number | null | undefined => {
  if (!raw.trim()) return null
  const t = Date.parse(raw.trim())
  return Number.isFinite(t) ? t : undefined
}
const num = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d))
const signed = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(d)}`)
const pad = (s: string, w: number) => (s.length >= w ? s : s + ' '.repeat(w - s.length))
const lpad = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s)

const venueOf = (a: AccountView): string => a.venue ?? a.type ?? ''
const isPerp = (a: AccountView) => (a.kind ?? 'exchange/perp') === 'exchange/perp' && a.status === 'ready' && venueOf(a) !== ''

export const accountHistoryScript: ScriptDefinition = {
  id: 'account-history',
  name: { en: 'Account history (positions, history, fills, funding)', 'zh-CN': '账户交易历史（持仓 / 仓位历史 / 成交 / 资金费）' },
  description: {
    en: 'Read one perp account from its venue for a time range and produce Binance\'s four tabs plus an equity curve as an HTML report. Read-only.',
    'zh-CN': '按时间范围从交易所读取一个合约账户的全部交易，生成与币安页面一致的四个页签（当前持仓 / 仓位历史 / 历史成交 / 资金费用）加收益曲线的 HTML 报告。只读。',
  },
  paramsSchema,

  paramOptions: async (runtime) => {
    const rt = runtime as Runtime
    const accounts = await rt.listAccounts()
    return {
      account: accounts.filter(isPerp).map(a => ({ value: a.name, label: `${a.name} (${venueOf(a)})` })),
    }
  },

  run: async ({ params, runtime, emit, signal }) => {
    const p = paramsSchema.parse(params)
    const rt = runtime as Runtime
    const out: string[] = []
    const say = (s = '') => { out.push(s); emit?.(s) }

    const ready = (await rt.listAccounts()).filter(isPerp)
    if (ready.length === 0) return { text: 'No ready perp account.' }
    const account = p.account === '' ? (ready.length === 1 ? ready[0] : undefined) : ready.find(a => a.name === p.account)
    if (!account) {
      return { text: p.account === ''
        ? `${ready.length} accounts are ready, pick one: ${ready.map(a => `${a.name} (${venueOf(a)})`).join(', ')}`
        : `No ready perp account named "${p.account}"` }
    }
    if (!account.credential) return { text: `Account "${account.name}" has no bound credential` }
    const venue = venueOf(account)

    if (!p.useCcxt && !NATIVE_VENUES.has(venue)) {
      return { text: [
        `The venue's own path exists for ${[...NATIVE_VENUES].join(', ')} only; "${account.name}" is on ${venue}.`,
        `Tick "Use the ccxt path (testing)" to read it through the generic ccxt path instead.`,
        `原生路径目前只实现了 ${[...NATIVE_VENUES].join('、')}；账户「${account.name}」在 ${venue} 上。勾选「使用 ccxt 通用路径（测试）」即可用通用路径读取。`,
      ].join('\n') }
    }

    const toMs = parseInstant(p.to), fromMs = parseInstant(p.from)
    if (toMs === undefined) return { text: `"To" is not a time: ${p.to}` }
    if (fromMs === undefined) return { text: `"From" is not a time: ${p.from}` }
    const to = toMs ?? Date.now()
    const from = fromMs ?? to - DEFAULT_RANGE_MS
    if (from >= to) return { text: 'The range is empty: "From" is not before "To".' }

    const session = await rt.adapters.resolve<unknown>('exchange/perp', venue, account.credential)
    if (!isHistorySession(session)) return { text: `The ${venue} adapter is not a ccxt adapter; the ccxt path cannot read it.` }
    const source = p.useCcxt ? 'ccxt' : 'native'
    const limits = source === 'native' ? BINANCE_LIMITS : limitsFor(session.exchange.id)

    const report = await collectHistory({
      account: account.name, venue, source, session: session as HistorySession, from, to,
      symbols: p.symbols.split(',').map(s => s.trim()).filter(Boolean),
      limits, signal, emit: say,
    })
    const t = report.totals

    // ── Text ───────────────────────────────────────────────────────────────
    say()
    say(`Realized  ${signed(t.tradePnl)}   fees ${num(t.quoteFees)}${Object.keys(t.otherFees).length ? ` (+ ${Object.entries(t.otherFees).map(([a, v]) => `${num(v, 6)} ${a}`).join(', ')})` : ''}   funding ${signed(t.funding)}   net ${signed(t.net)}`)
    say(`Volume    ${num(t.volumeUsd, 0)} (${report.fills.length} fills)`)
    say(`Open      ${report.positions.length} positions, unrealized ${signed(t.unrealizedPnl)}`)
    say(`History   ${report.history.length} episodes (${t.closedEpisodes} closed${report.history.some(r => r.estimated) ? `, ${report.history.filter(r => r.estimated).length} with estimated PnL` : ''})`)
    if (!report.complete) say('INCOMPLETE — see notes; the report covers what was read.')
    for (const n of report.notes) say(`  ! ${n}`)
    if (report.positions.length > 0) {
      say()
      say(`${pad('Position', 22)} ${pad('side', 6)} ${lpad('notional $', 12)} ${lpad('entry', 12)} ${lpad('mark', 12)} ${lpad('lev', 4)} ${lpad('uPnL', 10)} ${lpad('ROI%', 8)}  opened`)
      for (const r of report.positions) {
        say(`${pad(r.symbol, 22)} ${pad(r.direction, 6)} ${lpad(num(r.notional), 12)} ${lpad(num(r.entryPrice, 6), 12)} ${lpad(num(r.markPrice, 6), 12)} ${lpad(`${r.leverage}x`, 4)} ${lpad(signed(r.unrealizedPnl), 10)} ${lpad(signed(r.roiPct), 8)}  ${r.openedAt !== undefined ? iso(r.openedAt) : 'before range'}`)
      }
    }
    if (report.history.length > 0) {
      say()
      say(`${pad('History', 22)} ${pad('side', 6)} ${lpad('closed qty', 12)} ${lpad('open avg', 12)} ${lpad('close avg', 12)} ${lpad('PnL', 10)} ${lpad('ROI%', 8)} ${lpad('fees', 8)} ${lpad('funding', 8)}  opened → closed`)
      for (const r of report.history.slice(0, 40)) {
        say(`${pad(r.symbol, 22)} ${pad(r.direction, 6)} ${lpad(num(r.closedQty, 4), 12)} ${lpad(num(r.openAvg, 6), 12)} ${lpad(num(r.closeAvg, 6), 12)} ${lpad(signed(r.tradePnl) + (r.estimated ? '~' : ''), 10)} ${lpad(signed(r.roiPct), 8)} ${lpad(num(r.quoteFees), 8)} ${lpad(signed(r.funding), 8)}  ${r.truncated ? '<range' : iso(r.openedAt)} → ${r.closedAt !== undefined ? iso(r.closedAt) : 'open'}`)
      }
      if (report.history.length > 40) say(`  … ${report.history.length - 40} more in the HTML report`)
    }

    const stamp = new Date(report.generatedAt).toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const slug = (s: string) => s.replace(/[^\w.-]+/g, '_')
    return {
      text: out.join('\n'),
      json: { ...report, fills: undefined, funding: undefined, fillsCount: report.fills.length, fundingCount: report.funding.length },
      files: [{ name: `${slug(venue)}-${slug(account.name)}-${stamp}.html`, mime: 'text/html', content: renderHtml(report) }],
    }
  },
}
