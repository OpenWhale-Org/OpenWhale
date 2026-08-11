'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Per-instance PnL — realized / fees / funding from the order-claim
 * attribution ledger, plus the instance's own fills and fill-derived open
 * positions. Everything here is venue ground truth joined through claimed
 * order ids, so symbols shared with other instances stay separable.
 */

interface PnlSummary {
  realized: number
  fees: number
  funding: number
  net: number
  fillCount: number
  firstTs: number | null
  lastTs: number | null
  bySymbol: Array<{ symbol: string; realized: number; fees: number; funding: number; net: number; fills: number }>
}

interface FillRow {
  symbol: string; side: string; qty: number; price: number
  realizedPnl: number | null; fee: number | null; feeAsset: string | null
  orderId: string; account: string; ts: number
}

interface PositionRow {
  symbol: string; qty: number; avgEntry: number; account: string
  markPrice?: number; unrealizedPnl?: number
}

const fmt = (v: number, digits = 2) => {
  const s = v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return v > 0 ? `+${s}` : s
}

function pnlColor(v: number): string {
  if (v > 0.005) return 'var(--success)'
  if (v < -0.005) return 'var(--danger)'
  return 'var(--muted)'
}

type SortState = { key: string; desc: boolean } | null

/**
 * Click-to-sort table headers. Numbers open descending (the biggest loser or
 * the busiest symbol is what a PnL table is opened to find); text opens
 * ascending. Blanks sink either way, so an unpriced row never displaces a real
 * one at the top.
 */
function sortRows<T>(rows: T[], sort: SortState): T[] {
  if (!sort) return rows
  const { key, desc } = sort
  const pick = (r: T) => (r as Record<string, unknown>)[key]
  return [...rows].sort((a, b) => {
    const va = pick(a), vb = pick(b)
    const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))
    if (blank(va) && blank(vb)) return 0
    if (blank(va)) return 1
    if (blank(vb)) return -1
    if (typeof va === 'number' && typeof vb === 'number') return desc ? vb - va : va - vb
    const cmp = String(va).localeCompare(String(vb))
    return desc ? -cmp : cmp
  })
}

function SortableTh({ label, sortKey, numeric, sort, onSort }: {
  label: string
  sortKey: string
  numeric?: boolean
  sort: SortState
  onSort: (s: SortState) => void
}) {
  const active = sort?.key === sortKey
  return (
    <th
      className={`px-2 py-1 cursor-pointer select-none whitespace-nowrap ${numeric ? 'text-right' : 'text-left'}`}
      style={{ color: active ? 'var(--foreground)' : 'var(--muted)' }}
      onClick={() => onSort(active ? { key: sortKey, desc: !sort!.desc } : { key: sortKey, desc: Boolean(numeric) })}
      title="Click to sort"
    >
      {label}<span style={{ opacity: active ? 1 : 0.25 }}>{active ? (sort!.desc ? ' ▾' : ' ▴') : ' ⇅'}</span>
    </th>
  )
}

export function InstancePnlPanel({ instanceId }: { instanceId: string }) {
  const [open, setOpen] = useState(true)
  const [tab, setTab] = useState<'summary' | 'fills' | 'positions'>('summary')
  // One state per table: switching tabs must not carry a key the next table
  // does not have.
  const [symSort, setSymSort] = useState<SortState>(null)
  const [fillSort, setFillSort] = useState<SortState>(null)
  const [posSort, setPosSort] = useState<SortState>(null)
  const [summary, setSummary] = useState<PnlSummary | null>(null)
  const [fills, setFills] = useState<FillRow[]>([])
  const [positions, setPositions] = useState<PositionRow[]>([])
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, f, p] = await Promise.all([
        fetch(`/api/instances/${instanceId}/pnl`),
        fetch(`/api/instances/${instanceId}/fills?n=100`),
        fetch(`/api/instances/${instanceId}/positions`),
      ])
      if (!s.ok) throw new Error((await s.json() as { error?: string }).error ?? `HTTP ${s.status}`)
      setSummary(await s.json() as PnlSummary)
      if (f.ok) setFills(await f.json() as FillRow[])
      if (p.ok) setPositions(await p.json() as PositionRow[])
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [instanceId])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load])

  async function refresh() {
    setRefreshing(true)
    try {
      await fetch('/api/pnl/collect', { method: 'POST' })
      await load()
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="rounded-lg mb-4 overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="w-full flex items-center gap-2 px-4 py-3 text-sm font-medium">
        <button className="flex items-center gap-2" onClick={() => setOpen(v => !v)}>
          <span>{open ? '▾' : '▸'}</span>
          <span>PnL</span>
        </button>
        {summary && (
          <span className="text-sm font-mono" style={{ color: pnlColor(summary.net) }}>
            {fmt(summary.net)}
          </span>
        )}
        <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>
          attributed from claimed orders · funding split by exposure share
        </span>
        <button
          onClick={() => void refresh()}
          disabled={refreshing}
          className="ml-auto text-xs px-2 py-0.5 rounded"
          style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
        >
          {refreshing ? 'Collecting…' : '⟳ Collect now'}
        </button>
      </div>

      {open && (
        <div className="px-4 pb-4">
          {error && <div className="text-xs mb-2" style={{ color: 'var(--danger)' }}>{error}</div>}
          {summary && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-3">
                {([
                  ['Realized', summary.realized],
                  ['Fees', summary.fees],
                  ['Funding', summary.funding],
                  ['Net', summary.net],
                  ['Unrealized', positions.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0)],
                ] as const).map(([label, value]) => (
                  <div key={label} className="rounded-md p-3" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
                    <div className="text-xs" style={{ color: 'var(--muted)' }}>{label}</div>
                    <div className="text-lg font-mono" style={{ color: pnlColor(value) }}>{fmt(value)}</div>
                  </div>
                ))}
              </div>

              <div className="flex gap-2 mb-2">
                {(['summary', 'fills', 'positions'] as const).map(t => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className="px-2 py-0.5 rounded text-xs capitalize"
                    style={{
                      background: tab === t ? 'var(--accent)' : 'var(--background)',
                      color: tab === t ? '#fff' : 'var(--muted)',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {t === 'summary' ? `By symbol (${summary.bySymbol.length})` : t === 'fills' ? `Fills (${summary.fillCount})` : `Positions (${positions.length})`}
                  </button>
                ))}
              </div>

              <div className="overflow-x-auto overflow-y-auto font-mono text-xs" style={{ maxHeight: 320 }}>
                {tab === 'summary' && (
                  <table className="w-full">
                    <thead>
                      <tr>
                        <SortableTh label="symbol" sortKey="symbol" sort={symSort} onSort={setSymSort} />
                        <SortableTh label="realized" sortKey="realized" numeric sort={symSort} onSort={setSymSort} />
                        <SortableTh label="fees" sortKey="fees" numeric sort={symSort} onSort={setSymSort} />
                        <SortableTh label="funding" sortKey="funding" numeric sort={symSort} onSort={setSymSort} />
                        <SortableTh label="net" sortKey="net" numeric sort={symSort} onSort={setSymSort} />
                        <SortableTh label="fills" sortKey="fills" numeric sort={symSort} onSort={setSymSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {sortRows(summary.bySymbol, symSort).map(r => (
                        <tr key={r.symbol} style={{ borderTop: '1px solid var(--border)' }}>
                          <td className="px-2 py-1">{r.symbol}</td>
                          <td className="text-right px-2 py-1" style={{ color: pnlColor(r.realized) }}>{fmt(r.realized)}</td>
                          <td className="text-right px-2 py-1" style={{ color: pnlColor(r.fees) }}>{fmt(r.fees)}</td>
                          <td className="text-right px-2 py-1" style={{ color: pnlColor(r.funding) }}>{fmt(r.funding)}</td>
                          <td className="text-right px-2 py-1" style={{ color: pnlColor(r.net) }}>{fmt(r.net)}</td>
                          <td className="text-right px-2 py-1" style={{ color: 'var(--muted)' }}>{r.fills}</td>
                        </tr>
                      ))}
                      {summary.bySymbol.length === 0 && (
                        <tr><td colSpan={6} className="px-2 py-4 text-center" style={{ color: 'var(--muted)' }}>
                          No attributed activity yet — the collector joins venue fills to this instance&apos;s orders within ~30s of an execution.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                )}

                {tab === 'fills' && (
                  <table className="w-full">
                    <thead>
                      <tr>
                        <SortableTh label="time" sortKey="ts" numeric sort={fillSort} onSort={setFillSort} />
                        <SortableTh label="symbol" sortKey="symbol" sort={fillSort} onSort={setFillSort} />
                        <SortableTh label="side" sortKey="side" sort={fillSort} onSort={setFillSort} />
                        <SortableTh label="qty" sortKey="qty" numeric sort={fillSort} onSort={setFillSort} />
                        <SortableTh label="price" sortKey="price" numeric sort={fillSort} onSort={setFillSort} />
                        <SortableTh label="pnl" sortKey="realizedPnl" numeric sort={fillSort} onSort={setFillSort} />
                        <SortableTh label="fee" sortKey="fee" numeric sort={fillSort} onSort={setFillSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {sortRows(fills, fillSort).map((f, i) => (
                        <tr key={`${f.orderId}-${i}`} style={{ borderTop: '1px solid var(--border)' }}>
                          <td className="px-2 py-1" style={{ color: 'var(--muted)' }}>{new Date(f.ts).toLocaleString()}</td>
                          <td className="px-2 py-1">{f.symbol}</td>
                          <td className="px-2 py-1" style={{ color: f.side === 'buy' ? 'var(--success)' : 'var(--danger)' }}>{f.side}</td>
                          <td className="text-right px-2 py-1">{f.qty}</td>
                          <td className="text-right px-2 py-1">{f.price}</td>
                          <td className="text-right px-2 py-1" style={{ color: pnlColor(f.realizedPnl ?? 0) }}>{f.realizedPnl !== null ? fmt(f.realizedPnl, 4) : '—'}</td>
                          <td className="text-right px-2 py-1" style={{ color: 'var(--muted)' }}>{f.fee !== null ? f.fee.toFixed(4) : '—'}</td>
                        </tr>
                      ))}
                      {fills.length === 0 && (
                        <tr><td colSpan={7} className="px-2 py-4 text-center" style={{ color: 'var(--muted)' }}>No fills recorded yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                )}

                {tab === 'positions' && (
                  <table className="w-full">
                    <thead>
                      <tr>
                        <SortableTh label="symbol" sortKey="symbol" sort={posSort} onSort={setPosSort} />
                        <SortableTh label="net qty" sortKey="qty" numeric sort={posSort} onSort={setPosSort} />
                        <SortableTh label="avg entry" sortKey="avgEntry" numeric sort={posSort} onSort={setPosSort} />
                        <SortableTh label="mark" sortKey="markPrice" numeric sort={posSort} onSort={setPosSort} />
                        <SortableTh label="unrealized" sortKey="unrealizedPnl" numeric sort={posSort} onSort={setPosSort} />
                        <SortableTh label="account" sortKey="account" sort={posSort} onSort={setPosSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {sortRows(positions, posSort).map(p => (
                        <tr key={`${p.account}:${p.symbol}`} style={{ borderTop: '1px solid var(--border)' }}>
                          <td className="px-2 py-1">{p.symbol}</td>
                          <td className="text-right px-2 py-1" style={{ color: p.qty > 0 ? 'var(--success)' : 'var(--danger)' }}>{p.qty}</td>
                          <td className="text-right px-2 py-1">{p.avgEntry.toFixed(6)}</td>
                          <td className="text-right px-2 py-1">{p.markPrice !== undefined ? p.markPrice.toFixed(6) : '—'}</td>
                          <td className="text-right px-2 py-1" style={{ color: pnlColor(p.unrealizedPnl ?? 0) }}>
                            {p.unrealizedPnl !== undefined ? fmt(p.unrealizedPnl) : '—'}
                          </td>
                          <td className="px-2 py-1" style={{ color: 'var(--muted)' }}>{p.account}</td>
                        </tr>
                      ))}
                      {positions.length === 0 && (
                        <tr><td colSpan={6} className="px-2 py-4 text-center" style={{ color: 'var(--muted)' }}>
                          Flat — no open exposure derived from this instance&apos;s fills.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
