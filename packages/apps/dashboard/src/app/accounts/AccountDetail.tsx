'use client'

import { useCallback, useEffect, useState } from 'react'

/** Shapes follow the exchange read-view interfaces (IAccountBalance/IPosition/IOrder). */
interface TokenBalance { token: string; free: number; locked: number; total: number; usdValue?: number }
interface BalanceSection { usd: { available: number; total: number }; tokens: TokenBalance[] }
interface PositionRow { id: string; side: 'long' | 'short'; value: number; pnl: number }
interface OrderRow { id: string; side: 'buy' | 'sell'; value: number; status: 'open' | 'partial' }

interface DetailPayload {
  sections: { balance?: BalanceSection; positions?: PositionRow[]; orders?: OrderRow[] }
  errors: Record<string, string>
}

type Tab = 'positions' | 'balance' | 'orders'

function usd(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
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
