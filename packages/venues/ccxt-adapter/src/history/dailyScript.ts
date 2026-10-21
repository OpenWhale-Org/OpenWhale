import { z } from 'zod'
import type { ScriptDefinition } from '@openwhaleorg/core'
import { collectHistory } from './collect.js'
import { openPerpAccount, perpAccountOptions } from './script.js'
import { parseZone, parseCutoff, daySpans, bucketDays } from './daily.js'
import { renderDailyHtml } from './dailyReport.js'

/**
 * One perp account's last N days, cut at a time of day the reader names, as
 * a table of days and an HTML report. Read-only; the same collector and the
 * same native/ccxt switch as the account-history script.
 */

const MAX_DAYS = 90

const paramsSchema = z.object({
  account: z.string().default('').meta({
    displayName: 'Account',
    description: 'A perp account with a bound credential. Leave empty to use the sole ready one.',
    i18n: { 'zh-CN': { displayName: '账户', description: '已绑定凭证的合约账户。留空则使用唯一一个可用账户。' } },
  }),
  useCcxt: z.boolean().default(false).meta({
    displayName: 'Use the ccxt path (testing)',
    description: 'Off: the venue\'s own path — Binance only for now; other venues are refused. On: the generic ccxt path.',
    i18n: { 'zh-CN': { displayName: '使用 ccxt 通用路径（测试）', description: '不勾选走原生路径，目前只实现了币安，其他交易所会报错。勾选则走 ccxt 通用路径。' } },
  }),
  days: z.number().int().min(1).max(MAX_DAYS).default(7).meta({
    displayName: 'Days',
    description: `Whole days to read, ending at the latest cut; the day still running is added on top. 1–${MAX_DAYS}.`,
    i18n: { 'zh-CN': { displayName: '最近天数', description: `读取多少个完整的天，截止到最近一次切分时刻；还没结束的今天另外附在最后。1–${MAX_DAYS}。` } },
  }),
  cutoff: z.string().default('00:00:00').meta({
    displayName: 'Day cut',
    description: 'The time of day one day ends and the next begins, HH:MM[:SS], e.g. 23:59:00.',
    placeholder: '00:00:00',
    i18n: { 'zh-CN': { displayName: '每日切分时刻', description: '一天结束、下一天开始的时刻，HH:MM[:SS]，如 23:59:00。' } },
  }),
  timezone: z.string().default('UTC').meta({
    displayName: 'Time zone',
    description: 'The zone the cut is read in: an IANA name (Asia/Shanghai) or an offset (+08:00, UTC+8). Default UTC.',
    placeholder: 'Asia/Shanghai',
    i18n: { 'zh-CN': { displayName: '时区', description: '切分时刻按哪个时区算：IANA 名称（Asia/Shanghai）或偏移（+08:00、UTC+8）。默认 UTC。' } },
  }),
  symbols: z.string().default('').meta({
    displayName: 'Contracts',
    description: 'Comma-separated. Empty = every contract the account traded.',
    i18n: { 'zh-CN': { displayName: '合约', description: '逗号分隔。留空 = 账户交易过的全部合约。' } },
  }),
})

const money = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`
const lpad = (s: string, w: number) => (s.length >= w ? s : ' '.repeat(w - s.length) + s)

export const dailyTradingScript: ScriptDefinition = {
  id: 'daily-trading',
  name: { en: 'Daily trading analysis', 'zh-CN': '每日交易分析' },
  description: {
    en: 'Read one perp account for its last N days, cut each day at a chosen time of day, and report volume, realized PnL, fees, funding and net per day and per contract. Read-only.',
    'zh-CN': '读取一个合约账户最近 N 天的交易，按指定的每日时刻切分，逐日给出交易量、已实现盈亏、手续费、资金费、净盈亏及各合约明细。只读。',
  },
  paramsSchema,

  paramOptions: async (runtime) => ({ account: await perpAccountOptions(runtime) }),

  run: async ({ params, runtime, emit, signal }) => {
    const p = paramsSchema.parse(params)
    const zone = parseZone(p.timezone)
    if (!zone) return { text: `Unknown time zone "${p.timezone}". Use an IANA name such as Asia/Shanghai, or an offset such as +08:00.\n无法识别的时区「${p.timezone}」，请填 Asia/Shanghai 这样的名称或 +08:00 这样的偏移。` }
    const cutSec = parseCutoff(p.cutoff)
    if (cutSec === undefined) return { text: `"${p.cutoff}" is not a time of day; use HH:MM or HH:MM:SS.\n「${p.cutoff}」不是有效的时刻，请填 HH:MM 或 HH:MM:SS。` }
    const cutoff = [Math.floor(cutSec / 3600), Math.floor(cutSec / 60) % 60, cutSec % 60].map(n => String(n).padStart(2, '0')).join(':')

    const opened = await openPerpAccount(runtime, p.account, p.useCcxt)
    if (typeof opened === 'string') return { text: opened }

    const out: string[] = []
    const say = (s = '') => { out.push(s); emit?.(s) }
    const now = Date.now()
    const spans = daySpans(zone, cutSec, p.days, now)
    say(`Days      ${p.days} whole + today, cut at ${cutoff} ${zone.label}`)

    const report = await collectHistory({
      account: opened.name, venue: opened.venue, source: opened.source, session: opened.session,
      from: spans[0]!.start, to: now,
      symbols: p.symbols.split(',').map(s => s.trim()).filter(Boolean),
      limits: opened.limits, signal, emit: say,
    })
    const daily = bucketDays(report, spans, { zone: zone.label, cutoff })
    const t = daily.totals

    say()
    say(`${'Day'.padEnd(14)} ${lpad('fills', 7)} ${lpad('volume', 13)} ${lpad('realized', 10)} ${lpad('fees', 9)} ${lpad('funding', 9)} ${lpad('net', 10)} ${lpad('cum', 10)}`)
    for (const d of daily.days) {
      say(`${(d.label + (d.partial ? ' *' : '')).padEnd(14)} ${lpad(String(d.fills), 7)} ${lpad(d.volume.toFixed(0), 13)} ${lpad(money(d.realized), 10)} ${lpad(d.quoteFees.toFixed(2), 9)} ${lpad(money(d.funding), 9)} ${lpad(money(d.net), 10)} ${lpad(money(d.cumulative), 10)}`)
    }
    say(`${'Total'.padEnd(14)} ${lpad(String(t.fills), 7)} ${lpad(t.volume.toFixed(0), 13)} ${lpad(money(t.realized), 10)} ${lpad(t.quoteFees.toFixed(2), 9)} ${lpad(money(t.funding), 9)} ${lpad(money(t.net), 10)}`)
    say(`* still running. Win days ${t.winDays} / loss days ${t.lossDays} of ${t.wholeDays}.`)
    if (!daily.complete) say('INCOMPLETE — see notes; the report covers what was read.')
    for (const n of daily.notes) say(`  ! ${n}`)

    const stamp = new Date(now).toISOString().slice(0, 16).replace(/[:T]/g, '-')
    const slug = (s: string) => s.replace(/[^\w.-]+/g, '_')
    return {
      text: out.join('\n'),
      json: daily,
      files: [{ name: `daily-${slug(opened.venue)}-${slug(opened.name)}-${stamp}.html`, mime: 'text/html', content: renderDailyHtml(daily) }],
    }
  },
}
