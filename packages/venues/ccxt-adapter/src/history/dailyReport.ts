import { reportPage, esc, reportStamp, cls as tone } from '@openwhaleorg/core'
import type { DailyReport, DayRow, Tally } from './daily.js'

/**
 * The daily report: one row per day at the reader's cut, a bar per day with
 * the running total over it, and each day's contracts underneath. Pure data
 * in, one self-contained HTML file out; the chart is drawn here, not in the
 * browser, so the file reads the same with scripts off.
 */

const WEEK = ['日', '一', '二', '三', '四', '五', '六']

const plain = (v: number, d = 2) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const money = (v: number, d = 2) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${plain(Math.abs(v), d)}`
const bp = (t: Tally) => (t.volume > 0 ? (t.quoteFees / t.volume * 1e4).toFixed(2) : '—')
const makerPct = (t: Tally) => (t.flaggedVolume > 0 ? `${(t.makerVolume / t.flaggedVolume * 100).toFixed(0)}%` : '—')
const winPct = (closes: number, wins: number) => (closes > 0 ? `${(wins / closes * 100).toFixed(0)}%` : '—')
const others = (o: Record<string, number>) => Object.entries(o).map(([a, v]) => `${plain(v, 6)} ${a}`).join(', ')
const dayName = (d: DayRow) => `${d.label.slice(5)} 周${WEEK[d.weekday]}`

const CSS = `<style>
.dl-chart svg text{font-family:var(--f-mono);font-size:11px;fill:var(--ink-3)}
.dl-chart .bar.pos{fill:var(--gain)}.dl-chart .bar.neg{fill:var(--loss)}.dl-chart .bar.dim{fill:var(--rule-2)}
.dl-chart .bar.partial{opacity:.45}
.dl-chart .axis{stroke:var(--rule);stroke-width:1}.dl-chart .zero{stroke:var(--ink-3);stroke-width:1}
.dl-chart .cum{fill:none;stroke:var(--accent);stroke-width:1.8}.dl-chart .dot{fill:var(--accent)}
.dl-legend{display:flex;gap:16px;font-family:var(--f-sans);font-size:12px;color:var(--ink-3);margin:0 0 8px}
.dl-legend i{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px}
tr.partial td{color:var(--ink-3)}
tr.partial td.day::after{content:' 进行中';font-family:var(--f-sans);font-size:11px;color:var(--warn)}
</style>`

function chart(days: DayRow[]): string {
  if (days.length === 0) return ''
  const W = 960, H = 280, L = 64, R = 16, T = 14, B = 34
  const values = days.flatMap(d => [d.net, d.cumulative, 0])
  let lo = Math.min(...values), hi = Math.max(...values)
  if (hi - lo < 1e-9) { hi += 1; lo -= 1 }
  const pad = (hi - lo) * 0.08
  lo -= pad; hi += pad
  const y = (v: number) => T + (hi - v) / (hi - lo) * (H - T - B)
  const step = (W - L - R) / days.length
  const bw = Math.max(2, Math.min(36, step * 0.62))
  const x = (i: number) => L + step * i + step / 2

  const ticks: string[] = []
  for (let k = 0; k <= 4; k++) {
    const v = lo + (hi - lo) * k / 4
    ticks.push(`<line class="axis" x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${esc(money(v, Math.abs(hi - lo) > 200 ? 0 : 2))}</text>`)
  }
  const labelEvery = Math.max(1, Math.ceil(days.length / 16))
  const bars = days.map((d, i) => {
    const top = y(Math.max(0, d.net)), bottom = y(Math.min(0, d.net))
    const tip = `${d.label}${d.partial ? '（进行中）' : ''}\n净盈亏 ${money(d.net)}\n已实现 ${money(d.realized)} · 手续费 −${plain(d.quoteFees)} · 资金费 ${money(d.funding)}\n交易量 ${plain(d.volume, 0)} · ${d.fills} 笔\n累计 ${money(d.cumulative)}`
    const label = i % labelEvery === 0 || i === days.length - 1
      ? `<text x="${x(i).toFixed(1)}" y="${H - B + 16}" text-anchor="middle">${esc(d.label.slice(5))}</text>` : ''
    return `<rect class="bar ${tone(d.net)}${d.partial ? ' partial' : ''}" x="${(x(i) - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, bottom - top).toFixed(1)}"><title>${esc(tip)}</title></rect>${label}`
  }).join('')
  const line = days.map((d, i) => `${x(i).toFixed(1)},${y(d.cumulative).toFixed(1)}`).join(' ')
  const dots = days.map((d, i) => `<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(d.cumulative).toFixed(1)}" r="2.6"><title>${esc(`${d.label} 累计 ${money(d.cumulative)}`)}</title></circle>`).join('')
  return `<div class="dl-legend"><span><i style="background:var(--gain)"></i>当日净盈亏</span><span><i style="background:var(--accent);height:2px;vertical-align:3px"></i>累计净盈亏</span></div>
<div class="chart dl-chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="每日净盈亏">${ticks.join('')}<line class="zero" x1="${L}" x2="${W - R}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>${bars}<polyline class="cum" points="${line}"/>${dots}</svg></div>`
}

const th = (s: string, left = false) => `<th${left ? ' class="l"' : ''}>${s}</th>`
const td = (s: string, c = '') => `<td${c ? ` class="${c}"` : ''}>${s}</td>`

function dayTable(days: DayRow[]): string {
  const head = ['日期', '区间', '成交', '合约', '交易量', 'Maker', '已实现盈亏', '手续费', '费率 bp', '资金费', '净盈亏', '累计', '平仓段', '胜率']
  const rows = [...days].reverse().map(d => `<tr${d.partial ? ' class="partial"' : ''}>`
    + td(esc(dayName(d)), 'l day')
    + td(`${reportStamp(d.start)} → ${reportStamp(d.end)}`, 'l dim')
    + td(plain(d.fills, 0)) + td(String(d.contracts.length)) + td(plain(d.volume, 0)) + td(makerPct(d))
    + td(money(d.realized) + (d.estimated !== 0 ? '~' : ''), tone(d.realized))
    + td(`−${plain(d.quoteFees)}`, d.quoteFees > 0 ? 'neg' : 'dim')
    + td(bp(d)) + td(money(d.funding), tone(d.funding)) + td(money(d.net), tone(d.net)) + td(money(d.cumulative), tone(d.cumulative))
    + td(String(d.closes)) + td(winPct(d.closes, d.wins))
    + '</tr>').join('')
  return `<div class="tblwrap"><table class="slim"><thead><tr>${head.map((h, i) => th(h, i < 2)).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`
}

function contractTables(days: DayRow[]): string {
  const busy = [...days].reverse().filter(d => d.contracts.length > 0)
  if (busy.length === 0) return '<p class="empty">区间内没有成交或资金费。</p>'
  return busy.map((d, i) => `<details class="sum"${i === 0 ? ' open' : ''}><summary>${esc(dayName(d))}${d.partial ? '（进行中）' : ''} · ${d.contracts.length} 个合约 · 净 ${esc(money(d.net))}</summary>`
    + `<div class="tblwrap"><table class="slim"><thead><tr>${th('合约', true)}${th('成交')}${th('交易量')}${th('Maker')}${th('已实现盈亏')}${th('手续费')}${th('资金费')}${th('净盈亏')}</tr></thead><tbody>`
    + d.contracts.map(c => '<tr>' + td(esc(c.symbol), 'l') + td(plain(c.fills, 0)) + td(plain(c.volume, 0)) + td(makerPct(c))
      + td(money(c.realized) + (c.estimated !== 0 ? '~' : ''), tone(c.realized)) + td(`−${plain(c.quoteFees)}`, c.quoteFees > 0 ? 'neg' : 'dim')
      + td(c.fundingCount ? money(c.funding) : '—', tone(c.funding)) + td(money(c.net), tone(c.net)) + '</tr>').join('')
    + '</tbody></table></div></details>').join('')
}

export function renderDailyHtml(r: DailyReport): string {
  const t = r.totals
  const whole = r.days.filter(d => !d.partial)
  const avg = whole.length > 0 ? whole.reduce((s, d) => s + d.net, 0) / whole.length : 0
  const best = whole.length > 0 ? whole.reduce((a, b) => (b.net > a.net ? b : a)) : undefined
  const worst = whole.length > 0 ? whole.reduce((a, b) => (b.net < a.net ? b : a)) : undefined
  const other = others(t.otherFees)
  const first = r.days[0], last = r.days[r.days.length - 1]

  const body = `${CSS}
<p class="ident"><span>切分 每天 ${esc(r.cutoff)} ${esc(r.zone)}</span><span>区间 ${reportStamp(r.from)} → ${reportStamp(r.to)}</span><span>生成于 ${reportStamp(r.generatedAt)}</span></p>
${r.complete ? '' : `<p class="alarm">数据不完整：${r.notes.map(esc).join('；')}</p>`}
${t.estimated !== 0 ? `<p class="note">标「~」的已实现盈亏含估算部分：交易所没有在成交上回报盈亏，按开仓均价估算；区间开始前就开着的仓位估不出来，记 0。</p>` : ''}
<p class="dim">每一天从前一天的 ${esc(r.cutoff)} 到当天的 ${esc(r.cutoff)}（${esc(r.zone)}），以区间中点所在的日期命名。成交的交易量、手续费、已实现盈亏记在成交发生的那天，资金费记在结算的那天，跨天的仓位在平仓那天记盈亏。净盈亏 = 已实现 − 手续费 + 资金费，不含未实现盈亏。最后一行是还没结束的当天。</p>
<section><h3>每日净盈亏</h3>${chart(r.days)}</section>
<section><h3>每日明细</h3>${dayTable(r.days)}</section>
<section><h3>每日合约</h3>${contractTables(r.days)}</section>`

  return reportPage({
    title: `${r.account} · 每日交易分析`,
    eyebrow: `${r.venue} / daily-trading${r.source === 'ccxt' ? ' / ccxt' : ''}`,
    h1: `${r.account} 的每日交易`,
    lede: `最近 ${whole.length} 个完整交易日加上进行中的今天，每天在 ${r.cutoff}（${r.zone}）切分。`
      + (best && worst ? `最好的一天是 ${best.label}（${money(best.net)}），最差的是 ${worst.label}（${money(worst.net)}）。` : ''),
    ident: [r.account, r.venue, ...(r.source === 'ccxt' ? ['ccxt 通用路径'] : []), `${r.cutoff} ${r.zone}`,
      ...(first && last ? [`${first.label} → ${last.label}`] : []), `${whole.length} 天 + 今天`],
    figures: [
      { k: '总交易量', v: plain(t.volume, 0), n: `日均 ${plain(whole.length ? whole.reduce((s, d) => s + d.volume, 0) / whole.length : 0, 0)} · ${plain(t.fills, 0)} 笔` },
      { k: '已实现盈亏', v: money(t.realized), n: `${t.closes} 段平仓 · 胜率 ${winPct(t.closes, t.wins)}`, cls: tone(t.realized) },
      { k: '手续费', v: `−${plain(t.quoteFees)}`, n: other ? `另有 ${other}` : `${bp(t)} bp · Maker ${makerPct(t)}`, cls: 'neg' },
      { k: '资金费', v: money(t.funding), n: `${t.fundingCount} 次结算`, cls: tone(t.funding) },
      { k: '净盈亏', v: money(t.net), n: `盈利 ${t.winDays} 天 · 亏损 ${t.lossDays} 天`, cls: tone(t.net) },
      { k: '日均净盈亏', v: money(avg), n: `按 ${whole.length} 个完整日`, cls: tone(avg) },
    ],
    body,
    footer: '数据来自交易所的成交与资金费流水，与「账户交易历史」报告同一个收集器。'
      + '手续费只合计计价币种的部分，BNB 等其他资产另列。Maker 占比按交易量计，只统计交易所标注了 maker/taker 的成交。'
      + '胜率 = 当天平仓的仓位段中，扣除手续费、计入资金费后净盈利的比例。',
  })
}
