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

const cardStyle = { background: 'var(--background)', border: '1px solid var(--border)' } as const

function usd(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

/**
 * Kind-curated live account panel: the sections mirror what the account's
 * READ VIEW exposes — perp views ship positions, spot views don't, so the
 * curation follows the kind without any frontend switch.
 */
export function AccountDetail({ account }: { account: string }) {
  const [detail, setDetail] = useState<DetailPayload | null>(null)
  const [error, setError] = useState('')

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

  return (
    <div className="flex flex-col gap-3 mt-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Live account state</span>
        <button onClick={() => void load()} className="text-xs px-2 py-1 rounded-md" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
          ⟳ Refresh
        </button>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        {/* Positions — present only on kinds whose read view has positions() (perp) */}
        {(positions !== undefined || detail.errors['positions']) && (
          <div className="rounded-lg p-3" style={cardStyle}>
            <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--muted)' }}>
              Positions {positions ? `(${positions.length})` : ''}
            </h4>
            {detail.errors['positions'] && <p className="text-xs" style={{ color: 'var(--danger, #ef4444)' }}>{detail.errors['positions']}</p>}
            {positions?.length === 0 && <p className="text-xs" style={{ color: 'var(--muted)' }}>No open positions.</p>}
            {positions && positions.length > 0 && (
              /* A 280px track cannot hold four columns and a symbol like
                 SKHYNIX/USDT:USDT. Without a scroller the overflow is simply
                 clipped by the neighbouring card, and the uPnL column — the
                 one worth reading — is what disappears. */
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
                      <td className="py-1 font-mono max-w-0 truncate" title={p.id}>{p.id}</td>
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
          </div>
        )}

        {/* Balance — every kind */}
        <div className="rounded-lg p-3" style={cardStyle}>
          <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--muted)' }}>Balance</h4>
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
        </div>

        {/* Open orders — every kind */}
        <div className="rounded-lg p-3" style={cardStyle}>
          <h4 className="text-xs font-semibold mb-2" style={{ color: 'var(--muted)' }}>
            Open Orders {orders ? `(${orders.length})` : ''}
          </h4>
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
                    <td className="py-1 font-mono truncate" style={{ maxWidth: 120 }} title={o.id}>{o.id}</td>
                    <td className="py-1">{o.side}</td>
                    <td className="py-1 text-right font-mono">{usd(o.value)}</td>
                    <td className="py-1 pl-3">{o.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </div>
      </div>
    </div>
  )
}
