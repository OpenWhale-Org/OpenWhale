'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Select } from '@/components/Select'
import { DataTable, type Column, type SortState } from '@/components/DataTable'
import { useT } from '@/i18n'
import { fmtDateTime, fmtDateTimeMs } from '@/lib/time'

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
  /** Opened with the dust the previous round trip could not close. */
  carried?: boolean
}

interface Page<T> { rows: T[]; total: number; summary: Summary; unmatchedFunding?: number }
/** A page remembers which view asked for it, so a tab switch never renders rows of the wrong shape. */
type Loaded = Page<unknown> & { kind: Kind }

const PAGE_SIZES = [20, 50, 100, 200] as const
const PAGE_SIZE_KEY = 'ow:history:pageSize'
const LAYOUT_KEY = 'ow:history:layout'
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
  const [sort, setSort] = useState<SortState | undefined>(undefined)
  /*
   * Two readings of the same rows. The table compares — one line each, sort
   * by any column. The cards read one trade at a time, the way a venue's own
   * position history does, and they are what fits a phone.
   */
  const [layout, setLayoutState] = useState<'table' | 'cards'>('table')
  useEffect(() => {
    try { if (localStorage.getItem(LAYOUT_KEY) === 'cards') setLayoutState('cards') } catch { /* private mode */ }
  }, [])
  const setLayout = (v: 'table' | 'cards') => {
    setLayoutState(v)
    try { localStorage.setItem(LAYOUT_KEY, v) } catch { /* private mode */ }
  }
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

  useEffect(() => { setOffset(0) }, [kind, range, symbol, pageSize, sort])
  // Each view has its own columns, so a sort from the last one means nothing here.
  useEffect(() => { setSort(undefined) }, [kind])

  const load = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ offset: String(offset), limit: String(pageSize) })
    const ms = RANGES.find(r => r.key === range)!.ms
    if (ms > 0) params.set('since', String(Date.now() - ms))
    if (symbol) params.set('symbol', symbol)
    if (sort) { params.set('sort', sort.key); params.set('dir', sort.dir) }
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
  }, [base, kind, range, symbol, offset, pageSize, sort, t])

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
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {(['table', 'cards'] as const).map(v => (
              <button
                key={v}
                onClick={() => setLayout(v)}
                className="text-xs px-2 py-1"
                title={t(`history.layout.${v}Hint`)}
                style={{ background: layout === v ? 'var(--accent)' : 'transparent', color: layout === v ? 'white' : 'var(--muted)' }}
              >
                {t(`history.layout.${v}`)}
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
        <div className={layout === 'cards' ? '' : 'overflow-x-auto scroll-hidden'} style={{ opacity: loading ? 0.6 : 1 }}>
          {layout === 'cards' && <HistoryCards kind={kind} rows={page.rows} showAccount={showAccount} />}
          {layout === 'table' && kind === 'positions' && <PositionsTable rows={page.rows as PositionRow[]} showAccount={showAccount} sort={sort} onSort={setSort} />}
          {layout === 'table' && kind === 'fills' && <FillsTable rows={page.rows as FillRow[]} showAccount={showAccount} sort={sort} onSort={setSort} />}
          {layout === 'table' && kind === 'orders' && <OrdersTable rows={page.rows as OrderRow[]} showAccount={showAccount} sort={sort} onSort={setSort} />}
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

/**
 * One trade per card, the way a venue's own position history reads: what it
 * made, what it cost, and when — without the eye travelling across thirteen
 * columns. The table stays for comparing many rows at once.
 */
function HistoryCards({ kind, rows, showAccount }: { kind: Kind; rows: unknown[]; showAccount: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      {kind === 'positions' && (rows as PositionRow[]).map(p => <PositionCard key={`${p.account ?? ''}|${p.id}`} p={p} showAccount={showAccount} />)}
      {kind === 'fills' && (rows as FillRow[]).map(f => <FillCard key={`${f.account ?? ''}|${f.fillId}`} f={f} showAccount={showAccount} />)}
      {kind === 'orders' && (rows as OrderRow[]).map(o => <OrderCard key={`${o.account ?? ''}|${o.orderId}`} o={o} showAccount={showAccount} />)}
    </div>
  )
}

const cardStyle = { background: 'var(--surface)', border: '1px solid var(--border)' } as const

/** A label above its value, the card's unit of information. */
function Field({ label, value, color, title, align = 'left' }: {
  label: string; value: ReactNode; color?: string | undefined; title?: string; align?: 'left' | 'right'
}) {
  return (
    <div className={`flex flex-col gap-0.5 min-w-0 ${align === 'right' ? 'items-end text-right' : ''}`} title={title}>
      <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="text-sm font-mono truncate" style={color ? { color } : undefined}>{value}</span>
    </div>
  )
}

function CardHead({ symbol, side, positionSide, account, showAccount, badge }: {
  symbol: string; side: string; positionSide: string | null; account?: string | undefined; showAccount: boolean; badge?: ReactNode
}) {
  const bullish = side === 'long' || side === 'buy'
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] px-1.5 py-0.5 rounded" style={{
        background: bullish ? 'color-mix(in srgb, var(--success) 18%, transparent)' : 'color-mix(in srgb, var(--danger) 18%, transparent)',
        color: bullish ? 'var(--success)' : 'var(--danger)',
      }}>{side}</span>
      <span className="text-base font-semibold font-mono truncate">{symbol}</span>
      {positionSide && <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{positionSide}</span>}
      {showAccount && account && <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{account}</span>}
      <span className="flex-1" />
      {badge}
    </div>
  )
}

function PositionCard({ p, showAccount }: { p: PositionRow; showAccount: boolean }) {
  const t = useT()
  // Return on the size actually carried. Not the venue's ROI: that divides by
  // the margin behind the position, and the ledger has no leverage in it.
  const roi = p.maxNotional > 0 ? (p.net / p.maxNotional) * 100 : null
  const closed = p.closeTs !== null
  const status = closed
    ? (p.carried && p.fills === 0 ? t('history.dust') : t('history.card.closed'))
    : t('history.open')

  return (
    <div className="rounded-lg px-3 py-2.5 flex flex-col gap-2.5" style={cardStyle}>
      <CardHead
        symbol={p.symbol} side={p.side} positionSide={p.positionSide} account={p.account} showAccount={showAccount}
        badge={
          <span className="flex items-center gap-2">
            {p.partial && <Badge color="var(--warning, #f59e0b)" title={t('history.partialHint')}>{t('history.partial')}</Badge>}
            <span className="text-xs" style={{ color: closed ? 'var(--muted)' : 'var(--accent)' }}>{status}</span>
          </span>
        }
      />
      <div className="grid gap-y-2.5 gap-x-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(7.5rem, 1fr))' }}>
        <Field label={t('history.card.realizedUsd')} value={signedUsd(p.realized)} color={tone(p.realized)} />
        <Field label={t('history.card.roi')} value={roi === null ? '—' : `${roi > 0 ? '+' : ''}${roi.toFixed(2)}%`}
          color={tone(p.net)} title={t('history.card.roiHint')} />
        <Field label={t('history.card.maxSize')} value={usd(p.maxNotional)} title={qtyFmt(p.maxQty)} align="right" />
        <Field label={t('history.card.entry')} value={priceFmt(p.avgEntry)} />
        <Field label={t('history.card.exit')} value={p.avgExit === null ? '—' : priceFmt(p.avgExit)} />
        <Field label={t('history.card.volume')} value={usd(p.volume)} align="right" />
        <Field label={t('history.col.fees')} value={<FeeCell t={p} />} />
        <Field label={t('history.col.funding')} value={signedUsd(p.funding)} color={tone(p.funding)} />
        <Field label={t('history.col.net')} value={signedUsd(p.net)} color={tone(p.net)} title={t('history.netHint')} align="right" />
      </div>
      <div className="flex flex-col gap-1 pt-1 text-xs" style={{ borderTop: '1px solid var(--border)', color: 'var(--muted)' }}>
        <span className="flex justify-between gap-3">
          <span>{t('history.col.opened')}</span>
          <span className="font-mono">{fmtDateTimeMs(p.openTs)}</span>
        </span>
        <span className="flex justify-between gap-3">
          <span>{t('history.col.closed')}</span>
          <span className="font-mono">
            {closed ? `${fmtDateTimeMs(p.closeTs!)} · ${duration(p.closeTs! - p.openTs)}` : '—'}
          </span>
        </span>
        <span className="flex justify-between gap-3">
          <span title={t('history.col.fillsOrdersHint')}>{t('history.col.fillsOrders')}</span>
          <span className="font-mono">{p.fills} / {p.orders} · {t('history.card.rate', { rate: p.feeRate === null ? '—' : `${(p.feeRate * 10_000).toFixed(2)} bp` })}</span>
        </span>
      </div>
    </div>
  )
}

function FillCard({ f, showAccount }: { f: FillRow; showAccount: boolean }) {
  const t = useT()
  return (
    <div className="rounded-lg px-3 py-2.5 flex flex-col gap-2.5" style={cardStyle}>
      <CardHead symbol={f.symbol} side={f.side} positionSide={f.positionSide} account={f.account} showAccount={showAccount}
        badge={<span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{fmtDateTimeMs(f.ts)}</span>} />
      <div className="grid gap-y-2.5 gap-x-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(7.5rem, 1fr))' }}>
        <Field label={t('history.col.qty')} value={qtyFmt(f.qty)} />
        <Field label={t('history.col.price')} value={priceFmt(f.price)} />
        <Field label={t('history.col.notional')} value={usd(f.notional)} align="right" />
        <Field label={t('history.col.fees')} value={f.fee === null ? '—' : `${qtyFmt(f.fee)} ${f.feeAsset ?? ''}`} />
        <Field label={t('history.col.feeRate')} value={<RateCell rate={f.feeRate} />} />
        <Field label={t('history.col.realized')} value={f.realizedPnl === null ? '—' : signedUsd(f.realizedPnl)} color={tone(f.realizedPnl ?? 0)} align="right" />
      </div>
      <span className="text-[11px] font-mono truncate" style={{ color: 'var(--muted)' }} title={f.instanceId ?? t('history.unclaimed')}>
        {t('history.col.order')} {f.orderId}
      </span>
    </div>
  )
}

function OrderCard({ o, showAccount }: { o: OrderRow; showAccount: boolean }) {
  const t = useT()
  const net = o.realized - o.fees
  return (
    <div className="rounded-lg px-3 py-2.5 flex flex-col gap-2.5" style={cardStyle}>
      <CardHead symbol={o.symbol} side={o.side} positionSide={o.positionSide} account={o.account} showAccount={showAccount}
        badge={<span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{fmtDateTimeMs(o.lastTs)}</span>} />
      <div className="grid gap-y-2.5 gap-x-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(7.5rem, 1fr))' }}>
        <Field label={t('history.col.fills')} value={String(o.fills)} />
        <Field label={t('history.col.qty')} value={qtyFmt(o.qty)} />
        <Field label={t('history.col.avgPrice')} value={priceFmt(o.avgPrice)} align="right" />
        <Field label={t('history.col.notional')} value={usd(o.notional)} />
        <Field label={t('history.col.fees')} value={<FeeCell t={o} />} />
        <Field label={t('history.col.net')} value={signedUsd(net)} color={tone(net)} title={t('history.col.orderNetHint')} align="right" />
      </div>
      <span className="text-[11px] font-mono truncate" style={{ color: 'var(--muted)' }} title={o.instanceId ?? t('history.unclaimed')}>
        {t('history.col.order')} {o.orderId}
        {o.firstTs !== o.lastTs && ` · ${duration(o.lastTs - o.firstTs)}`}
      </span>
    </div>
  )
}

type TableProps<T> = { rows: T[]; showAccount: boolean; sort: SortState | undefined; onSort: (s: SortState | undefined) => void }

/** The account column only exists on a view that spans several accounts. */
function withAccount<T extends { account?: string }>(showAccount: boolean, label: string, rest: Array<Column<T>>): Array<Column<T>> {
  const account: Column<T> = { id: 'account', label, sort: 'account', width: 120, render: r => r.account ?? '—' }
  return showAccount ? [account, ...rest] : rest
}

function PositionsTable({ rows, showAccount, sort, onSort }: TableProps<PositionRow>) {
  const t = useT()
  const columns = useMemo<Array<Column<PositionRow>>>(() => withAccount(showAccount, t('history.col.account'), [
    { id: 'symbol', label: t('history.col.symbol'), sort: 'symbol', grow: true, render: p => (
      <span className="font-mono">
        {p.symbol}
        {p.partial && <Badge color="var(--warning, #f59e0b)" title={t('history.partialHint')}>{t('history.partial')}</Badge>}
        {p.carried && p.fills === 0 && <Badge color="var(--muted)" title={t('history.dustHint')}>{t('history.dust')}</Badge>}
      </span>
    ) },
    { id: 'side', label: t('history.col.side'), sort: 'side', width: 96, render: p => <Side side={p.side} positionSide={p.positionSide} /> },
    { id: 'opened', label: t('history.col.opened'), sort: 'openTs', width: 176, render: p => <span className="font-mono">{fmtDateTimeMs(p.openTs)}</span> },
    { id: 'closed', label: t('history.col.closed'), sort: 'closeTs', width: 220, render: p => (
      p.closeTs === null
        ? <Badge color="var(--accent)" title={t('history.openHint', { qty: qtyFmt(p.openQty) })}>{t('history.open')}</Badge>
        : <span className="font-mono">{fmtDateTimeMs(p.closeTs)} <span style={{ color: 'var(--muted)' }}>· {duration(p.closeTs - p.openTs)}</span></span>
    ) },
    { id: 'maxSize', label: t('history.col.maxSize'), sort: 'maxNotional', align: 'right', width: 104, render: p => <span className="font-mono" title={qtyFmt(p.maxQty)}>{usd(p.maxNotional)}</span> },
    { id: 'entryExit', label: t('history.col.entryExit'), align: 'right', width: 200, render: p => (
      <span className="font-mono">{priceFmt(p.avgEntry)} → {p.avgExit === null ? '—' : priceFmt(p.avgExit)}</span>
    ) },
    { id: 'fillsOrders', label: t('history.col.fillsOrders'), sort: 'fills', align: 'right', width: 96, title: t('history.col.fillsOrdersHint'), render: p => <span className="font-mono">{p.fills} / {p.orders}</span> },
    { id: 'volume', label: t('history.col.volume'), sort: 'volume', align: 'right', width: 104, render: p => <span className="font-mono">{usd(p.volume)}</span> },
    { id: 'fees', label: t('history.col.fees'), sort: 'fees', align: 'right', width: 96, render: p => <span className="font-mono"><FeeCell t={p} /></span> },
    { id: 'feeRate', label: t('history.col.feeRate'), sort: 'feeRate', align: 'right', width: 88, render: p => <span className="font-mono"><RateCell rate={p.feeRate} /></span> },
    { id: 'funding', label: t('history.col.funding'), sort: 'funding', align: 'right', width: 92, render: p => <span className="font-mono" style={{ color: tone(p.funding) }}>{signedUsd(p.funding)}</span> },
    { id: 'realized', label: t('history.col.realized'), sort: 'realized', align: 'right', width: 96, render: p => <span className="font-mono" style={{ color: tone(p.realized) }}>{signedUsd(p.realized)}</span> },
    { id: 'net', label: t('history.col.net'), sort: 'net', align: 'right', width: 96, title: t('history.netHint'), render: p => <span className="font-mono" style={{ color: tone(p.net) }}>{signedUsd(p.net)}</span> },
  ]), [showAccount, t])

  return <DataTable tableId="history.positions" columns={columns} rows={rows} rowKey={p => `${p.account ?? ''}|${p.id}`} sort={sort} onSort={onSort} minWidth="72rem" />
}

function FillsTable({ rows, showAccount, sort, onSort }: TableProps<FillRow>) {
  const t = useT()
  const columns = useMemo<Array<Column<FillRow>>>(() => withAccount(showAccount, t('history.col.account'), [
    { id: 'time', label: t('history.col.time'), sort: 'ts', width: 176, render: f => <span className="font-mono">{fmtDateTimeMs(f.ts)}</span> },
    { id: 'symbol', label: t('history.col.symbol'), sort: 'symbol', grow: true, render: f => <span className="font-mono">{f.symbol}</span> },
    { id: 'side', label: t('history.col.side'), sort: 'side', width: 96, render: f => <Side side={f.side} positionSide={f.positionSide} /> },
    { id: 'qty', label: t('history.col.qty'), sort: 'qty', align: 'right', width: 104, render: f => <span className="font-mono">{qtyFmt(f.qty)}</span> },
    { id: 'price', label: t('history.col.price'), sort: 'price', align: 'right', width: 112, render: f => <span className="font-mono">{priceFmt(f.price)}</span> },
    { id: 'notional', label: t('history.col.notional'), sort: 'notional', align: 'right', width: 104, render: f => <span className="font-mono">{usd(f.notional)}</span> },
    { id: 'fees', label: t('history.col.fees'), sort: 'fee', align: 'right', width: 112, render: f => <span className="font-mono">{f.fee === null ? '—' : `${qtyFmt(f.fee)} ${f.feeAsset ?? ''}`}</span> },
    { id: 'feeRate', label: t('history.col.feeRate'), sort: 'feeRate', align: 'right', width: 88, render: f => <span className="font-mono"><RateCell rate={f.feeRate} /></span> },
    { id: 'realized', label: t('history.col.realized'), sort: 'realizedPnl', align: 'right', width: 96, render: f => (
      <span className="font-mono" style={{ color: tone(f.realizedPnl ?? 0) }}>{f.realizedPnl === null ? '—' : signedUsd(f.realizedPnl)}</span>
    ) },
    { id: 'order', label: t('history.col.order'), sort: 'orderId', width: 140, render: f => (
      <span className="font-mono" style={{ color: 'var(--muted)' }} title={f.instanceId ?? t('history.unclaimed')}>{f.orderId}</span>
    ) },
  ]), [showAccount, t])

  return <DataTable tableId="history.fills" columns={columns} rows={rows} rowKey={f => `${f.account ?? ''}|${f.fillId}`} sort={sort} onSort={onSort} minWidth="64rem" />
}

function OrdersTable({ rows, showAccount, sort, onSort }: TableProps<OrderRow>) {
  const t = useT()
  const columns = useMemo<Array<Column<OrderRow>>>(() => withAccount(showAccount, t('history.col.account'), [
    { id: 'time', label: t('history.col.time'), sort: 'lastTs', width: 200, render: o => (
      <span className="font-mono" title={o.firstTs !== o.lastTs ? `${fmtDateTimeMs(o.firstTs)} → ${fmtDateTimeMs(o.lastTs)}` : undefined}>
        {fmtDateTimeMs(o.lastTs)}
        {o.firstTs !== o.lastTs && <span style={{ color: 'var(--muted)' }}> · {duration(o.lastTs - o.firstTs)}</span>}
      </span>
    ) },
    { id: 'order', label: t('history.col.order'), sort: 'orderId', width: 140, render: o => (
      <span className="font-mono" style={{ color: 'var(--muted)' }} title={o.instanceId ?? t('history.unclaimed')}>{o.orderId}</span>
    ) },
    { id: 'symbol', label: t('history.col.symbol'), sort: 'symbol', grow: true, render: o => <span className="font-mono">{o.symbol}</span> },
    { id: 'side', label: t('history.col.side'), sort: 'side', width: 96, render: o => <Side side={o.side} positionSide={o.positionSide} /> },
    { id: 'fills', label: t('history.col.fills'), sort: 'fills', align: 'right', width: 88, render: o => <span className="font-mono">{o.fills}</span> },
    { id: 'qty', label: t('history.col.qty'), sort: 'qty', align: 'right', width: 104, render: o => <span className="font-mono">{qtyFmt(o.qty)}</span> },
    { id: 'avgPrice', label: t('history.col.avgPrice'), sort: 'avgPrice', align: 'right', width: 112, render: o => <span className="font-mono">{priceFmt(o.avgPrice)}</span> },
    { id: 'notional', label: t('history.col.notional'), sort: 'notional', align: 'right', width: 104, render: o => <span className="font-mono">{usd(o.notional)}</span> },
    { id: 'fees', label: t('history.col.fees'), sort: 'fees', align: 'right', width: 96, render: o => <span className="font-mono"><FeeCell t={o} /></span> },
    { id: 'feeRate', label: t('history.col.feeRate'), sort: 'feeRate', align: 'right', width: 88, render: o => <span className="font-mono"><RateCell rate={o.feeRate} /></span> },
    { id: 'realized', label: t('history.col.realized'), sort: 'realized', align: 'right', width: 96, render: o => <span className="font-mono" style={{ color: tone(o.realized) }}>{signedUsd(o.realized)}</span> },
    { id: 'net', label: t('history.col.net'), align: 'right', width: 96, title: t('history.col.orderNetHint'), render: o => {
      const net = o.realized - o.fees
      return <span className="font-mono" style={{ color: tone(net) }}>{signedUsd(net)}</span>
    } },
  ]), [showAccount, t])

  return <DataTable tableId="history.orders" columns={columns} rows={rows} rowKey={o => `${o.account ?? ''}|${o.orderId}`} sort={sort} onSort={onSort} minWidth="72rem" />
}
