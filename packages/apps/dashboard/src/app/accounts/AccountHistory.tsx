'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Select } from '@/components/Select'
import { useT } from '@/i18n'
import { fmtDateTime } from '@/lib/time'

/**
 * Trade history of one account, read from the PnL ledger: positions (fills
 * replayed flat to flat), fills, and orders (fills grouped by venue order).
 * Every view carries its fees, PnL and the fee rate they imply; the summary
 * strip covers the whole filtered window, not just the page on screen.
 */

type Kind = 'positions' | 'fills' | 'orders'

interface FeeTotals { fees: number; feesOther: Record<string, number>; feeVolume: number; feeRate: number | null }

interface Summary extends FeeTotals { count: number; volume: number; realized: number; funding: number; net: number }

interface FillRow extends FeeTotals {
  account?: string
  fillId: string; orderId: string; instanceId: string | null; symbol: string; positionSide: string | null
  side: 'buy' | 'sell'; qty: number; price: number; notional: number
  realizedPnl: number | null; fee: number | null; feeAsset: string | null; ts: number
}

interface OrderRow extends FeeTotals {
  account?: string
  orderId: string; instanceId: string | null; symbol: string; positionSide: string | null; side: 'buy' | 'sell'
  fills: number; qty: number; avgPrice: number; notional: number; realized: number; firstTs: number; lastTs: number
}

interface PositionRow extends FeeTotals {
  account?: string
  id: string; symbol: string; positionSide: string | null; side: 'long' | 'short'
  openTs: number; closeTs: number | null; maxQty: number; maxNotional: number; avgEntry: number; avgExit: number | null
  openQty: number; fills: number; orders: number; volume: number; realized: number; funding: number; net: number
  instanceIds: string[]; partial: boolean
}

interface Page<T> { rows: T[]; total: number; summary: Summary; unmatchedFunding?: number }
/** A page remembers which view asked for it, so a tab switch never renders rows of the wrong shape. */
type Loaded = Page<unknown> & { kind: Kind }

const PAGE_SIZES = [20, 50, 100, 200] as const
const PAGE_SIZE_KEY = 'ow:history:pageSize'
const RANGES = [
  { key: '1d', ms: 24 * 3600_000 },
  { key: '7d', ms: 7 * 24 * 3600_000 },
  { key: '30d', ms: 30 * 24 * 3600_000 },
  { key: 'all', ms: 0 },
] as const
type RangeKey = typeof RANGES[number]['key']

const num = (v: number, digits = 2) => v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
const usd = (v: number) => `${v < 0 ? '-' : ''}$${num(Math.abs(v))}`
const signedUsd = (v: number) => `${v > 0 ? '+' : ''}${usd(v)}`
const tone = (v: number) => (v > 0 ? 'var(--success)' : v < 0 ? 'var(--danger)' : undefined)
const qtyFmt = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 6 })
const priceFmt = (v: number) => v.toLocaleString(undefined, { maximumSignificantDigits: 8 })

/** A fee rate reads best in basis points; the percent is in the tooltip. */
function RateCell({ rate }: { rate: number | null }) {
  if (rate === null) return <span style={{ color: 'var(--muted)' }}>—</span>
  return <span title={`${(rate * 100).toFixed(4)}%`}>{(rate * 10_000).toFixed(2)} bp</span>
}

function FeeCell({ t }: { t: FeeTotals }) {
  const other = Object.entries(t.feesOther).filter(([, v]) => v !== 0)
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{usd(t.fees)}</span>
      {other.map(([a, v]) => <span key={a} className="text-[10px]" style={{ color: 'var(--muted)' }}>+{qtyFmt(v)} {a}</span>)}
    </span>
  )
}

function duration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** One account's history. */
export function AccountHistory({ account }: { account: string }) {
  return <HistoryPanel base={`/api/accounts/${encodeURIComponent(account)}/history`} backfillAccount={account} />
}

/**
 * Pull this account's history from the venue, as far back as it still serves.
 *
 * The routine collector reads a few days of the contracts it knows about;
 * this walks the account-wide ledger for every contract it ever traded and
 * fetches each one's fills. Minutes of venue calls, so it runs detached and
 * this button just watches.
 */
function BackfillButton({ account, onDone }: { account: string; onDone: () => void }) {
  const t = useT()
  const [state, setState] = useState<{ running: boolean; progress: string } | null>(null)
  const [error, setError] = useState('')
  const wasRunning = useRef(false)

  useEffect(() => {
    if (!state?.running) return
    const timer = setInterval(() => {
      void fetch('/api/pnl/backfill')
        .then(r => (r.ok ? r.json() : null))
        .then((s: { running: boolean; progress: string } | null) => {
          if (!s) return
          setState(s)
          if (wasRunning.current && !s.running) { wasRunning.current = false; onDone() }
          if (s.running) wasRunning.current = true
        })
        .catch(() => {})
    }, 2_000)
    return () => clearInterval(timer)
  }, [state?.running, onDone])

  async function start() {
    setError('')
    try {
      const r = await fetch('/api/pnl/backfill', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, days: 90 }),
      })
      const body = await r.json() as { error?: string }
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
      wasRunning.current = true
      setState({ running: true, progress: '' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{error}</span>}
      {state?.running && <span className="text-[11px] font-mono" style={{ color: 'var(--muted)' }}>{state.progress || '…'}</span>}
      <button
        onClick={() => void start()}
        disabled={state?.running}
        title={t('history.backfillHint')}
        className="text-xs px-2 py-1 rounded-md"
        style={{ border: '1px solid var(--border)', color: state?.running ? 'var(--muted)' : 'var(--foreground)' }}
      >
        {state?.running ? t('history.backfilling') : t('history.backfill')}
      </button>
    </span>
  )
}

/**
 * History for any ledger scope the gateway serves under `base` — an account,
 * or a combination (`showAccount` adds the column, since its rows come from
 * several accounts).
 */
export function HistoryPanel({ base, showAccount = false, backfillAccount }: { base: string; showAccount?: boolean; backfillAccount?: string }) {
  const t = useT()
  const [pageSize, setPageSizeState] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(PAGE_SIZE_KEY))
      return (PAGE_SIZES as readonly number[]).includes(v) ? v : 50
    } catch { return 50 }
  })
  const setPageSize = (v: number) => {
    setPageSizeState(v)
    try { localStorage.setItem(PAGE_SIZE_KEY, String(v)) } catch { /* private mode */ }
  }
  const [kind, setKind] = useState<Kind>('positions')
  const [range, setRange] = useState<RangeKey>('7d')
  const [symbol, setSymbol] = useState('')
  const [symbols, setSymbols] = useState<string[]>([])
  const [offset, setOffset] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const request = useRef(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    setSymbol('')
    setOffset(0)
    fetch(`${base}/symbols`)
      .then(r => (r.ok ? r.json() : []))
      .then((list: string[]) => setSymbols(Array.isArray(list) ? list : []))
      .catch(() => setSymbols([]))
  }, [base])

  useEffect(() => { setOffset(0) }, [kind, range, symbol, pageSize])

  const load = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ offset: String(offset), limit: String(pageSize) })
    const ms = RANGES.find(r => r.key === range)!.ms
    if (ms > 0) params.set('since', String(Date.now() - ms))
    if (symbol) params.set('symbol', symbol)
    try {
      const res = await fetch(`${base}/${kind}?${params}`)
      const body = await res.json() as Page<unknown> & { error?: string }
      if (id !== request.current) return
      if (!res.ok) { setError(body.error ?? t('history.loadFailed')); setLoaded(null); return }
      setLoaded({ ...body, kind })
    } catch (err) {
      if (id !== request.current) return
      setError(err instanceof Error ? err.message : String(err))
      setLoaded(null)
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [base, kind, range, symbol, offset, pageSize, t])

  useEffect(() => { void load() }, [load, nonce])

  const symbolOptions = useMemo(() => [
    { value: '', label: t('history.allSymbols') },
    ...symbols.map(s => ({ value: s, label: s })),
  ], [symbols, t])

  const page = loaded?.kind === kind ? loaded : null
  const pages = page ? Math.max(1, Math.ceil(page.total / pageSize)) : 1
  const current = Math.floor(offset / pageSize) + 1

  return (
    <section className="flex flex-col">
      <div className="flex items-end justify-between gap-3 flex-wrap" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex">
          {(['positions', 'fills', 'orders'] as const).map(k => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className="px-3 py-2 text-xs"
              style={{
                color: kind === k ? 'var(--foreground)' : 'var(--muted)',
                borderBottom: kind === k ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {t(`history.tab.${k}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 mb-1.5 flex-wrap">
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {RANGES.map(r => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className="text-xs px-2 py-1"
                style={{ background: range === r.key ? 'var(--accent)' : 'transparent', color: range === r.key ? 'white' : 'var(--muted)' }}
              >
                {t(`history.range.${r.key}`)}
              </button>
            ))}
          </div>
          <Select size="sm" className="w-44" value={symbol} options={symbolOptions} onChange={setSymbol} searchable />
          {backfillAccount && <BackfillButton account={backfillAccount} onDone={() => setNonce(n => n + 1)} />}
          <button
            onClick={() => setNonce(n => n + 1)}
            className="text-xs px-2 py-1 rounded-md"
            style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            {t('accounts.detail.refresh')}
          </button>
        </div>
      </div>

      {page && <SummaryStrip kind={kind} page={page} />}
      {kind === 'positions' && <p className="text-[11px] pb-2" style={{ color: 'var(--muted)' }}>{t('history.positionsNote')}</p>}

      {error && <p className="text-xs py-3" style={{ color: 'var(--danger)' }}>{error}</p>}
      {!error && !page && loading && <p className="text-xs py-3" style={{ color: 'var(--muted)' }}>{t('accounts.detail.loading')}</p>}
      {page && page.rows.length === 0 && <p className="text-xs py-3" style={{ color: 'var(--muted)' }}>{t('history.empty')}</p>}

      {page && page.rows.length > 0 && (
        <div className="overflow-x-auto scroll-hidden" style={{ opacity: loading ? 0.6 : 1 }}>
          {kind === 'positions' && <PositionsTable rows={page.rows as PositionRow[]} showAccount={showAccount} />}
          {kind === 'fills' && <FillsTable rows={page.rows as FillRow[]} showAccount={showAccount} />}
          {kind === 'orders' && <OrdersTable rows={page.rows as OrderRow[]} showAccount={showAccount} />}
        </div>
      )}

      {page && (
        <div className="flex items-center justify-end gap-2 pt-2 text-xs flex-wrap" style={{ color: 'var(--muted)' }}>
          <span>{t('history.pageOf', { page: current, pages, total: page.total })}</span>
          <Select
            size="sm"
            className="w-24"
            value={String(pageSize)}
            options={PAGE_SIZES.map(n => ({ value: String(n), label: t('history.perPage', { n }) }))}
            onChange={v => setPageSize(Number(v))}
          />
          <PagerButton disabled={offset === 0} onClick={() => setOffset(0)}>«</PagerButton>
          <PagerButton disabled={offset === 0} onClick={() => setOffset(o => Math.max(0, o - pageSize))}>‹</PagerButton>
          <PageJump current={current} pages={pages} onJump={p => setOffset((p - 1) * pageSize)} />
          <PagerButton disabled={current >= pages} onClick={() => setOffset(o => o + pageSize)}>›</PagerButton>
          <PagerButton disabled={current >= pages} onClick={() => setOffset((pages - 1) * pageSize)}>»</PagerButton>
        </div>
      )}
    </section>
  )
}

/** The page number, editable: type a page and press Enter. */
function PageJump({ current, pages, onJump }: { current: number; pages: number; onJump: (page: number) => void }) {
  const [draft, setDraft] = useState(String(current))
  useEffect(() => { setDraft(String(current)) }, [current])
  const commit = () => {
    const n = Math.min(pages, Math.max(1, Math.floor(Number(draft)) || current))
    setDraft(String(n))
    if (n !== current) onJump(n)
  }
  return (
    <input
      value={draft}
      onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit() }}
      className="w-10 h-6 rounded-md text-center font-mono"
      style={{ border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground)' }}
    />
  )
}

function PagerButton({ disabled, onClick, children }: { disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="w-7 h-6 rounded-md"
      style={{ border: '1px solid var(--border)', color: disabled ? 'var(--border)' : 'var(--foreground)', cursor: disabled ? 'default' : 'pointer' }}
    >
      {children}
    </button>
  )
}

function SummaryStrip({ kind, page }: { kind: Kind; page: Page<unknown> }) {
  const t = useT()
  const s = page.summary
  const other = Object.entries(s.feesOther).filter(([, v]) => v !== 0)
  const items: Array<{ label: string; value: ReactNode; color?: string; title?: string }> = [
    { label: t(`history.count.${kind}`), value: s.count.toLocaleString() },
    { label: t('history.volume'), value: usd(s.volume) },
    {
      label: t('history.fees'),
      value: <>{usd(s.fees)}{other.map(([a, v]) => <span key={a} className="text-[11px] ml-1" style={{ color: 'var(--muted)' }}>+{qtyFmt(v)} {a}</span>)}</>,
      ...(other.length > 0 ? { title: t('history.feesOtherHint') } : {}),
    },
    { label: t('history.feeRate'), value: <RateCell rate={s.feeRate} />, title: t('history.feeRateHint') },
    { label: t('history.realized'), value: signedUsd(s.realized), ...(tone(s.realized) ? { color: tone(s.realized)! } : {}) },
    { label: t('history.funding'), value: signedUsd(s.funding), ...(tone(s.funding) ? { color: tone(s.funding)! } : {}) },
    { label: t('history.net'), value: signedUsd(s.net), ...(tone(s.net) ? { color: tone(s.net)! } : {}), title: t('history.netHint') },
  ]
  if (kind === 'positions' && page.unmatchedFunding) {
    items.push({ label: t('history.unmatchedFunding'), value: signedUsd(page.unmatchedFunding), title: t('history.unmatchedFundingHint') })
  }
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1.5 py-2.5">
      {items.map(it => (
        <div key={it.label} className="flex flex-col" title={it.title}>
          <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{it.label}</span>
          <span className="text-sm font-mono" style={it.color ? { color: it.color } : undefined}>{it.value}</span>
        </div>
      ))}
    </div>
  )
}

function Th({ children, right, title }: { children: ReactNode; right?: boolean; title?: string }) {
  return <th title={title} className={`py-1 pr-3 font-medium whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}>{children}</th>
}

function Td({ children, right, color, mono = true, title }: { children: ReactNode; right?: boolean; color?: string | undefined; mono?: boolean; title?: string }) {
  return (
    <td title={title} className={`py-1 pr-3 whitespace-nowrap ${right ? 'text-right' : ''} ${mono ? 'font-mono' : ''}`} style={color ? { color } : undefined}>
      {children}
    </td>
  )
}

function Side({ side, positionSide }: { side: string; positionSide: string | null }) {
  const bullish = side === 'long' || side === 'buy'
  return (
    <span style={{ color: bullish ? 'var(--success)' : 'var(--danger)' }}>
      {side}{positionSide ? <span className="text-[10px] ml-1" style={{ color: 'var(--muted)' }}>{positionSide}</span> : null}
    </span>
  )
}

function Badge({ children, color, title }: { children: ReactNode; color: string; title?: string }) {
  return (
    <span title={title} className="text-[10px] px-1 py-px rounded ml-1" style={{ border: `1px solid ${color}`, color }}>
      {children}
    </span>
  )
}

function PositionsTable({ rows, showAccount }: { rows: PositionRow[]; showAccount: boolean }) {
  const t = useT()
  return (
    <table className="w-full text-xs">
      <thead>
        <tr style={{ color: 'var(--muted)' }}>
          {showAccount && <Th>{t('history.col.account')}</Th>}
          <Th>{t('history.col.symbol')}</Th>
          <Th>{t('history.col.side')}</Th>
          <Th>{t('history.col.opened')}</Th>
          <Th>{t('history.col.closed')}</Th>
          <Th right>{t('history.col.maxSize')}</Th>
          <Th right>{t('history.col.entryExit')}</Th>
          <Th right title={t('history.col.fillsOrdersHint')}>{t('history.col.fillsOrders')}</Th>
          <Th right>{t('history.col.volume')}</Th>
          <Th right>{t('history.col.fees')}</Th>
          <Th right>{t('history.col.feeRate')}</Th>
          <Th right>{t('history.col.funding')}</Th>
          <Th right>{t('history.col.realized')}</Th>
          <Th right title={t('history.netHint')}>{t('history.col.net')}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(p => (
          <tr key={`${p.account ?? ''}|${p.id}`} style={{ borderTop: '1px solid var(--border)' }}>
            {showAccount && <Td mono={false}>{p.account}</Td>}
            <Td>
              {p.symbol}
              {p.partial && <Badge color="var(--warning, #f59e0b)" title={t('history.partialHint')}>{t('history.partial')}</Badge>}
            </Td>
            <Td mono={false}><Side side={p.side} positionSide={p.positionSide} /></Td>
            <Td>{fmtDateTime(p.openTs)}</Td>
            <Td>
              {p.closeTs === null
                ? <Badge color="var(--accent)" title={t('history.openHint', { qty: qtyFmt(p.openQty) })}>{t('history.open')}</Badge>
                : <span title={fmtDateTime(p.closeTs)}>{fmtDateTime(p.closeTs)} <span style={{ color: 'var(--muted)' }}>· {duration(p.closeTs - p.openTs)}</span></span>}
            </Td>
            <Td right title={`${qtyFmt(p.maxQty)}`}>{usd(p.maxNotional)}</Td>
            <Td right>{priceFmt(p.avgEntry)} → {p.avgExit === null ? '—' : priceFmt(p.avgExit)}</Td>
            <Td right>{p.fills} / {p.orders}</Td>
            <Td right>{usd(p.volume)}</Td>
            <Td right><FeeCell t={p} /></Td>
            <Td right><RateCell rate={p.feeRate} /></Td>
            <Td right color={tone(p.funding)}>{signedUsd(p.funding)}</Td>
            <Td right color={tone(p.realized)}>{signedUsd(p.realized)}</Td>
            <Td right color={tone(p.net)}>{signedUsd(p.net)}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function FillsTable({ rows, showAccount }: { rows: FillRow[]; showAccount: boolean }) {
  const t = useT()
  return (
    <table className="w-full text-xs">
      <thead>
        <tr style={{ color: 'var(--muted)' }}>
          <Th>{t('history.col.time')}</Th>
          {showAccount && <Th>{t('history.col.account')}</Th>}
          <Th>{t('history.col.symbol')}</Th>
          <Th>{t('history.col.side')}</Th>
          <Th right>{t('history.col.qty')}</Th>
          <Th right>{t('history.col.price')}</Th>
          <Th right>{t('history.col.notional')}</Th>
          <Th right>{t('history.col.fees')}</Th>
          <Th right>{t('history.col.feeRate')}</Th>
          <Th right>{t('history.col.realized')}</Th>
          <Th>{t('history.col.order')}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(f => (
          <tr key={`${f.account ?? ''}|${f.fillId}`} style={{ borderTop: '1px solid var(--border)' }}>
            <Td>{fmtDateTime(f.ts)}</Td>
            {showAccount && <Td mono={false}>{f.account}</Td>}
            <Td>{f.symbol}</Td>
            <Td mono={false}><Side side={f.side} positionSide={f.positionSide} /></Td>
            <Td right>{qtyFmt(f.qty)}</Td>
            <Td right>{priceFmt(f.price)}</Td>
            <Td right>{usd(f.notional)}</Td>
            <Td right>
              {f.fee === null ? '—' : `${qtyFmt(f.fee)} ${f.feeAsset ?? ''}`}
            </Td>
            <Td right><RateCell rate={f.feeRate} /></Td>
            <Td right color={tone(f.realizedPnl ?? 0)}>{f.realizedPnl === null ? '—' : signedUsd(f.realizedPnl)}</Td>
            <Td title={f.instanceId ?? t('history.unclaimed')}>
              <span style={{ color: 'var(--muted)' }}>{f.orderId}</span>
            </Td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function OrdersTable({ rows, showAccount }: { rows: OrderRow[]; showAccount: boolean }) {
  const t = useT()
  return (
    <table className="w-full text-xs">
      <thead>
        <tr style={{ color: 'var(--muted)' }}>
          <Th>{t('history.col.time')}</Th>
          {showAccount && <Th>{t('history.col.account')}</Th>}
          <Th>{t('history.col.order')}</Th>
          <Th>{t('history.col.symbol')}</Th>
          <Th>{t('history.col.side')}</Th>
          <Th right>{t('history.col.fills')}</Th>
          <Th right>{t('history.col.qty')}</Th>
          <Th right>{t('history.col.avgPrice')}</Th>
          <Th right>{t('history.col.notional')}</Th>
          <Th right>{t('history.col.fees')}</Th>
          <Th right>{t('history.col.feeRate')}</Th>
          <Th right>{t('history.col.realized')}</Th>
          <Th right title={t('history.col.orderNetHint')}>{t('history.col.net')}</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map(o => {
          const net = o.realized - o.fees
          return (
            <tr key={`${o.account ?? ''}|${o.orderId}`} style={{ borderTop: '1px solid var(--border)' }}>
              <Td title={o.firstTs !== o.lastTs ? `${fmtDateTime(o.firstTs)} → ${fmtDateTime(o.lastTs)}` : undefined}>
                {fmtDateTime(o.lastTs)}
                {o.firstTs !== o.lastTs && <span style={{ color: 'var(--muted)' }}> · {duration(o.lastTs - o.firstTs)}</span>}
              </Td>
              {showAccount && <Td mono={false}>{o.account}</Td>}
              <Td title={o.instanceId ?? t('history.unclaimed')}><span style={{ color: 'var(--muted)' }}>{o.orderId}</span></Td>
              <Td>{o.symbol}</Td>
              <Td mono={false}><Side side={o.side} positionSide={o.positionSide} /></Td>
              <Td right>{o.fills}</Td>
              <Td right>{qtyFmt(o.qty)}</Td>
              <Td right>{priceFmt(o.avgPrice)}</Td>
              <Td right>{usd(o.notional)}</Td>
              <Td right><FeeCell t={o} /></Td>
              <Td right><RateCell rate={o.feeRate} /></Td>
              <Td right color={tone(o.realized)}>{signedUsd(o.realized)}</Td>
              <Td right color={tone(net)}>{signedUsd(net)}</Td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
