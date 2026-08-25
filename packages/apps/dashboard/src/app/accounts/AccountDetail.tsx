'use client'

import { useCallback, useEffect, useState } from 'react'

/** Shapes follow the exchange read-view interfaces (IAccountBalance/IPosition/IOrder). */
interface TokenBalance { token: string; free: number; locked: number; total: number; usdValue?: number }
interface BalanceSection { usd: { available: number; total: number }; tokens: TokenBalance[] }
interface PositionRow { id: string; side: 'long' | 'short'; value: number; pnl: number }
interface OrderRow { id: string; side: 'buy' | 'sell'; value: number; status: 'open' | 'partial' }

/** Mirrors core's AccountSectionDef/AccountColumnDef — a declared layout, when the implementation ships one. */
interface ColumnDef { key: string; label: string; format?: 'text' | 'mono' | 'number' | 'usd' | 'pct' | 'signed' | 'side' | 'time' | 'badge'; digits?: number; align?: 'left' | 'right'; grow?: boolean }
interface SectionDef { method: string; title: string; kind: 'table' | 'keyvalue'; columns?: ColumnDef[]; count?: boolean; default?: boolean; empty?: string }

interface DetailPayload {
  sections: { balance?: BalanceSection; positions?: PositionRow[]; orders?: OrderRow[] } & Record<string, unknown>
  errors: Record<string, string>
  layout?: SectionDef[]
}

type Tab = 'positions' | 'balance' | 'orders'

function usd(v: number | undefined): string {
  // A read view that doesn't speak the perp convention leaves fields out —
  // show a dash rather than crash the pane.
  if (typeof v !== 'number' || Number.isNaN(v)) return '—'
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

function fmtCell(value: unknown, col: ColumnDef): { text: string; color?: string } {
  const d = col.digits
  if (value === undefined || value === null) return { text: '—', color: 'var(--muted)' }
  switch (col.format) {
    case 'usd': return typeof value === 'number' ? { text: `$${value.toLocaleString(undefined, { maximumFractionDigits: d ?? 2 })}` } : { text: String(value) }
    case 'number': return typeof value === 'number' ? { text: value.toLocaleString(undefined, { maximumFractionDigits: d ?? 4 }) } : { text: String(value) }
    case 'pct': return typeof value === 'number' ? { text: `${value.toFixed(d ?? 2)}%` } : { text: String(value) }
    case 'signed': {
      if (typeof value !== 'number') return { text: String(value) }
      const text = `${value > 0 ? '+' : ''}${value.toLocaleString(undefined, { maximumFractionDigits: d ?? 2 })}`
      return { text, color: value > 0 ? 'var(--success)' : value < 0 ? 'var(--danger)' : undefined }
    }
    case 'side': {
      const v = String(value).toLowerCase()
      const bullish = v === 'long' || v === 'buy'
      return { text: v, color: bullish ? 'var(--success)' : 'var(--danger)' }
    }
    case 'time': return { text: typeof value === 'number' ? new Date(value).toLocaleString() : String(value) }
    default: return { text: String(value) }
  }
}

/** A declared table section: rows by the implementation's own columns. */
function DeclaredTable({ rows, def }: { rows: Array<Record<string, unknown>>; def: SectionDef }) {
  const columns: ColumnDef[] = def.columns ?? Object.keys(rows[0] ?? {}).map(key => ({ key, label: key }))
  if (rows.length === 0) return <p className="text-xs" style={{ color: 'var(--muted)' }}>{def.empty ?? `No ${def.title.toLowerCase()}.`}</p>
  return (
    <div className="overflow-x-auto scroll-hidden">
      <table className="w-full text-xs" style={{ minWidth: '17rem' }}>
        <thead>
          <tr style={{ color: 'var(--muted)' }}>
            {columns.map(c => (
              <th key={c.key} className={`py-1 font-medium ${c.align === 'right' ? 'text-right' : 'text-left'}`} style={c.grow ? { width: '100%' } : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              {columns.map(c => {
                const cell = fmtCell(row[c.key], c)
                const mono = c.format === 'mono' || c.format === 'usd' || c.format === 'number' || c.format === 'pct' || c.format === 'signed'
                return (
                  <td
                    key={c.key}
                    className={`py-1 pr-3 whitespace-nowrap ${c.align === 'right' ? 'text-right' : 'text-left'} ${mono ? 'font-mono' : ''}`}
                    style={cell.color ? { color: cell.color } : undefined}
                  >
                    {c.format === 'badge'
                      ? <span className="px-1.5 py-0.5 rounded text-[11px]" style={{ background: 'color-mix(in srgb, var(--border) 40%, transparent)' }}>{cell.text}</span>
                      : cell.text}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A declared key/value section: one object, columns describe its fields. */
function DeclaredKeyValue({ data, def }: { data: Record<string, unknown>; def: SectionDef }) {
  const columns: ColumnDef[] = def.columns ?? Object.keys(data).map(key => ({ key, label: key }))
  return (
    <div className="grid gap-x-6 gap-y-1.5 text-xs" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(12rem, 1fr))' }}>
      {columns.map(c => {
        const cell = fmtCell(data[c.key], c)
        return (
          <div key={c.key} className="flex items-baseline justify-between gap-3" style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
            <span style={{ color: 'var(--muted)' }}>{c.label}</span>
            <span className="font-mono" style={cell.color ? { color: cell.color } : undefined}>{cell.text}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Kind-curated live account panel: the sections mirror what the account's
 * READ VIEW exposes — perp views ship positions, spot views don't, so the
 * curation follows the kind without any frontend switch.
 *
 * The sections are TABS rather than three side-by-side cards: each one is a
 * four-column table, and thirds of the pane truncated every symbol and
 * clipped the uPnL column. One section at full width reads instead.
 */
export function AccountDetail({ account }: { account: string }) {
  const [detail, setDetail] = useState<DetailPayload | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('positions')

  const load = useCallback(async () => {
    setDetail(null)
    setError('')
    const res = await fetch(`/api/accounts/${encodeURIComponent(account)}/detail`)
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? 'failed to load')
      return
    }
    setDetail(await res.json() as DetailPayload)
  }, [account])

  useEffect(() => { void load() }, [load])

  if (error) {
    return <p className="text-xs px-3 py-4" style={{ color: 'var(--danger, #ef4444)' }}>{error}</p>
  }
  if (!detail) {
    return <p className="text-xs px-3 py-4" style={{ color: 'var(--muted)' }}>Loading account detail…</p>
  }

  if (detail.layout && detail.layout.length > 0) {
    return <DeclaredDetail detail={detail} layout={detail.layout} onReload={() => void load()} />
  }

  const { balance, positions, orders } = detail.sections

  const tabs: { key: Tab; label: string }[] = []
  if (positions !== undefined || detail.errors['positions'])
    tabs.push({ key: 'positions', label: `Positions${positions ? ` (${positions.length})` : ''}` })
  tabs.push({ key: 'balance', label: 'Balance' })
  tabs.push({ key: 'orders', label: `Open Orders${orders ? ` (${orders.length})` : ''}` })

  // A spot account has no positions tab, so the default can point at a tab
  // that isn't there — fall back rather than render an empty pane.
  const active = tabs.some(t => t.key === tab) ? tab : tabs[0]!.key

  return (
    <div className="flex flex-col mt-3">
      <div className="flex items-end justify-between gap-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className="px-3 py-2 text-xs"
              style={{
                color: active === t.key ? 'var(--foreground)' : 'var(--muted)',
                borderBottom: active === t.key ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: '-1px',
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => void load()}
          className="text-xs px-2 py-1 mb-1.5 rounded-md shrink-0"
          style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
        >
          ⟳ Refresh
        </button>
      </div>

      <div className="pt-3">
        {/* Positions — present only on kinds whose read view has positions() (perp) */}
        {active === 'positions' && (
          <>
            {detail.errors['positions'] && <p className="text-xs" style={{ color: 'var(--danger, #ef4444)' }}>{detail.errors['positions']}</p>}
            {positions?.length === 0 && <p className="text-xs" style={{ color: 'var(--muted)' }}>No open positions.</p>}
            {positions && positions.length > 0 && (
              <div className="overflow-x-auto scroll-hidden">
                <table className="w-full text-xs" style={{ minWidth: '17rem' }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)' }}>
                      <th className="text-left py-1 font-medium">Symbol</th>
                      <th className="text-left py-1 font-medium">Side</th>
                      <th className="text-right py-1 font-medium">Value</th>
                      <th className="text-right py-1 font-medium">uPnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {positions.map(p => (
                      <tr key={`${p.id}-${p.side}`} style={{ borderTop: '1px solid var(--border)' }}>
                        <td className="py-1 font-mono">{p.id}</td>
                        <td className="py-1">
                          <span style={{ color: p.side === 'long' ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>{p.side}</span>
                        </td>
                        <td className="py-1 text-right font-mono">{usd(p.value)}</td>
                        <td className="py-1 text-right font-mono" style={{ color: p.pnl >= 0 ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)' }}>
                          {p.pnl >= 0 ? '+' : ''}{usd(p.pnl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* Balance — every kind */}
        {active === 'balance' && (
          <>
            {detail.errors['balance'] && <p className="text-xs" style={{ color: 'var(--danger, #ef4444)' }}>{detail.errors['balance']}</p>}
            {balance && (
              <>
                <div className="flex gap-4 mb-2 text-sm">
                  <span>Total <span className="font-mono">{usd(balance.usd.total)}</span></span>
                  <span style={{ color: 'var(--muted)' }}>Available <span className="font-mono">{usd(balance.usd.available)}</span></span>
                </div>
                <div className="overflow-x-auto scroll-hidden">
                  <table className="w-full text-xs" style={{ minWidth: '15rem' }}>
                    <thead>
                      <tr style={{ color: 'var(--muted)' }}>
                        <th className="text-left py-1 font-medium">Token</th>
                        <th className="text-right py-1 font-medium">Free</th>
                        <th className="text-right py-1 font-medium">Locked</th>
                        <th className="text-right py-1 font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {balance.tokens.filter(t => t.total !== 0).map(t => (
                        <tr key={t.token} style={{ borderTop: '1px solid var(--border)' }}>
                          <td className="py-1 font-mono">{t.token}</td>
                          <td className="py-1 text-right font-mono">{t.free.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                          <td className="py-1 text-right font-mono">{t.locked.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                          <td className="py-1 text-right font-mono">{t.total.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )}

        {/* Open orders — every kind */}
        {active === 'orders' && (
          <>
            {detail.errors['orders'] && <p className="text-xs" style={{ color: 'var(--danger, #ef4444)' }}>{detail.errors['orders']}</p>}
            {orders?.length === 0 && <p className="text-xs" style={{ color: 'var(--muted)' }}>No open orders.</p>}
            {orders && orders.length > 0 && (
              <div className="overflow-x-auto scroll-hidden">
                <table className="w-full text-xs" style={{ minWidth: '16rem' }}>
                  <thead>
                    <tr style={{ color: 'var(--muted)' }}>
                      <th className="text-left py-1 font-medium">Order</th>
                      <th className="text-left py-1 font-medium">Side</th>
                      <th className="text-right py-1 font-medium">Value</th>
                      <th className="text-left py-1 pl-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map(o => (
                      <tr key={o.id} style={{ borderTop: '1px solid var(--border)' }}>
                        <td className="py-1 font-mono">{o.id}</td>
                        <td className="py-1">{o.side}</td>
                        <td className="py-1 text-right font-mono">{usd(o.value)}</td>
                        <td className="py-1 pl-3">{o.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}


/** The panel for an implementation that declares its own sections. */
function DeclaredDetail({ detail, layout, onReload }: { detail: DetailPayload; layout: SectionDef[]; onReload: () => void }) {
  const [tab, setTab] = useState<string>(layout.find(sec => sec.default)?.method ?? layout[0]!.method)
  const active = layout.some(sec => sec.method === tab) ? tab : layout[0]!.method
  const current = layout.find(sec => sec.method === active)!
  const data = detail.sections[current.method]
  const rowsOf = (sec: SectionDef): unknown[] | undefined => {
    const v = detail.sections[sec.method]
    return Array.isArray(v) ? v : undefined
  }
  return (
    <div className="flex flex-col mt-3">
      <div className="flex items-end justify-between gap-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex">
          {layout.map(sec => {
            const rows = rowsOf(sec)
            return (
              <button
                key={sec.method}
                onClick={() => setTab(sec.method)}
                className="px-3 py-2 text-xs"
                style={{
                  color: active === sec.method ? 'var(--foreground)' : 'var(--muted)',
                  borderBottom: active === sec.method ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: '-1px',
                }}
              >
                {sec.title}{sec.count && rows ? ` (${rows.length})` : ''}
              </button>
            )
          })}
        </div>
        <button onClick={onReload} className="text-xs px-2 py-1 mb-1.5 rounded-md shrink-0" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
          ⟳ Refresh
        </button>
      </div>
      <div className="pt-3">
        {detail.errors[current.method] && <p className="text-xs" style={{ color: 'var(--danger)' }}>{detail.errors[current.method]}</p>}
        {data === undefined && !detail.errors[current.method] && <p className="text-xs" style={{ color: 'var(--muted)' }}>No data.</p>}
        {data !== undefined && current.kind === 'table' && Array.isArray(data) && <DeclaredTable rows={data as Array<Record<string, unknown>>} def={current} />}
        {data !== undefined && current.kind === 'keyvalue' && typeof data === 'object' && data !== null && !Array.isArray(data) && <DeclaredKeyValue data={data as Record<string, unknown>} def={current} />}
      </div>
    </div>
  )
}
