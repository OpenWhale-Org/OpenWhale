'use client'

import { useState } from 'react'
import type { AccountView, AccountImplementationInfo, AccountSnapshotRecord, CredentialInfo, CredentialTypeInfo } from '@openwhaleorg/core'
import { EquityChart } from './EquityChart'
import { AccountDetail } from './AccountDetail'

interface Props {
  initialAccounts: AccountView[]
  initialSnapshots: Record<string, AccountSnapshotRecord>
  implementations: AccountImplementationInfo[]
  credentials: CredentialInfo[]
  credentialTypes: CredentialTypeInfo[]
}

function formatUsd(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `$${(v / 1_000).toFixed(1)}k`
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
}

const inputStyle = {
  background: 'var(--background)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
} as const

/**
 * Accounts — the first-class entities of economic activity.
 * implementation × credential → a live venue account. Strategies read them,
 * executors write them; an account without a credential exists but is inactive.
 */
export function AccountsClient({ initialAccounts, initialSnapshots, implementations, credentials, credentialTypes }: Props) {
  const [accounts, setAccounts] = useState(initialAccounts)
  const [snapshots, setSnapshots] = useState(initialSnapshots)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [implId, setImplId] = useState(implementations[0]?.id ?? '')
  const [credential, setCredential] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const impl = implementations.find(i => i.id === implId)

  // Eligible credentials: the implementation's pinned type, or (kind-generic)
  // any type whose adapter cells cover the implementation's kind.
  const eligibleCredentials = credentials.filter((c) => {
    if (!impl) return false
    if (impl.type !== undefined) return c.type === impl.type
    const typeInfo = credentialTypes.find(t => t.type === c.type)
    return typeInfo?.kinds.includes(impl.kind) ?? false
  })

  async function refresh() {
    const res = await fetch('/api/accounts')
    if (res.ok) {
      const data = await res.json() as { accounts: AccountView[]; snapshots: Record<string, AccountSnapshotRecord> }
      setAccounts(data.accounts)
      setSnapshots(data.snapshots)
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, implementation: implId, ...(credential ? { credential } : {}) }),
      })
      if (!res.ok) {
        setError(((await res.json()) as { error?: string }).error ?? 'failed')
        return
      }
      setName(''); setCredential('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove(accountName: string) {
    setError('')
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountName)}`, { method: 'DELETE' })
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? 'delete failed')
    await refresh()
  }

  async function rebind(account: AccountView, credentialName: string) {
    setError('')
    const res = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: account.name, implementation: account.implementation, ...(credentialName ? { credential: credentialName } : {}) }),
    })
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? 'rebind failed')
    await refresh()
  }

  async function sampleNow() {
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/accounts/snapshot', { method: 'POST' })
      if (res.ok) {
        const data = await res.json() as { accounts: AccountView[]; snapshots: Record<string, AccountSnapshotRecord> }
        setAccounts(data.accounts)
        setSnapshots(data.snapshots)
        const failed = data.accounts.filter(a => a.snapshotError)
        if (failed.length > 0) {
          setError(failed.map(a => `${a.name}: ${a.snapshotError}`).join(' · '))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div className="px-4 py-2 rounded-md text-sm" style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={() => void sampleNow()}
          disabled={busy}
          className="text-xs px-3 py-1.5 rounded-md"
          style={{ border: '1px solid var(--border)', color: 'var(--muted)', opacity: busy ? 0.6 : 1 }}
          title="Take an equity snapshot of every account right now (normally sampled every 5 minutes)"
        >
          {busy ? 'Sampling…' : '⟳ Sample now'}
        </button>
      </div>

      {/* Account list */}
      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              <th className="text-left px-4 py-2 font-medium">Name</th>
              <th className="text-left px-4 py-2 font-medium">Implementation</th>
              <th className="text-left px-4 py-2 font-medium">Kind / Venue</th>
              <th className="text-left px-4 py-2 font-medium">Credential</th>
              <th className="text-left px-4 py-2 font-medium">Equity</th>
              <th className="text-left px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {accounts.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-6 text-center" style={{ color: 'var(--muted)' }}>
                No accounts yet — create one below. Strategies read accounts; executors write them.
              </td></tr>
            )}
            {accounts.map((a) => {
              const rebindable = credentials.filter((c) => {
                const ai = implementations.find(i => i.id === a.implementation)
                if (!ai) return false
                if (ai.type !== undefined) return c.type === ai.type
                const typeInfo = credentialTypes.find(t => t.type === c.type)
                return typeInfo?.kinds.includes(ai.kind) ?? false
              })
              const latest = snapshots[a.name]
              return (
                <>
                <tr key={a.name} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="px-4 py-2 font-mono">
                    <button
                      onClick={() => setExpanded(expanded === a.name ? null : a.name)}
                      className="flex items-center gap-1.5"
                      title="Show equity curve"
                    >
                      <span className="text-xs" style={{ color: 'var(--muted)' }}>{expanded === a.name ? '▾' : '▸'}</span>
                      {a.name}
                    </button>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{a.implementation}</td>
                  <td className="px-4 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                    {a.kind ?? '—'}{a.type ? ` · ${a.type}` : ''}
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={a.credential ?? ''}
                      onChange={(e) => rebind(a, e.target.value)}
                      className="rounded-md px-2 py-1 text-xs"
                      style={inputStyle}
                    >
                      <option value="">— unbound —</option>
                      {rebindable.map(c => <option key={c.id} value={c.name}>{c.name} ({c.type})</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-2 text-sm">
                    {latest ? formatUsd(latest.equity) : <span style={{ color: 'var(--muted)' }}>—</span>}
                    {a.snapshotError && (
                      <span
                        className="ml-1.5 text-xs cursor-help"
                        style={{ color: 'var(--danger, #ef4444)' }}
                        title={`Last snapshot failed: ${a.snapshotError}`}
                      >
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className="px-2 py-0.5 rounded-full text-xs"
                      style={{
                        background: a.status === 'ready' ? 'color-mix(in srgb, var(--success, #22c55e) 15%, transparent)'
                          : a.status === 'inactive' ? 'color-mix(in srgb, var(--warning, #eab308) 15%, transparent)'
                          : 'color-mix(in srgb, var(--danger, #ef4444) 15%, transparent)',
                        color: a.status === 'ready' ? 'var(--success, #22c55e)' : a.status === 'inactive' ? 'var(--warning, #eab308)' : 'var(--danger, #ef4444)',
                      }}
                      title={a.problem}
                    >
                      {a.status}{a.problem ? ' ⓘ' : ''}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => remove(a.name)} className="text-xs px-2 py-1 rounded-md" style={{ color: 'var(--danger, #ef4444)', border: '1px solid var(--border)' }}>
                      Delete
                    </button>
                  </td>
                </tr>
                {expanded === a.name && (
                  <tr key={`${a.name}-chart`} style={{ background: 'var(--surface)' }}>
                    <td colSpan={7} className="px-4 py-4">
                      <EquityChart account={a.name} />
                      {a.status === 'ready' && <AccountDetail account={a.name} />}
                    </td>
                  </tr>
                )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Create form */}
      <form onSubmit={create} className="flex flex-col gap-3 p-4 rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <h2 className="text-sm font-semibold">New Account</h2>
        <div className="flex flex-wrap gap-3">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Account name, e.g. BN-Main-Perp"
            className="rounded-md px-3 py-2 text-sm flex-1 min-w-48"
            style={inputStyle}
          />
          <select value={implId} onChange={(e) => { setImplId(e.target.value); setCredential('') }} className="rounded-md px-3 py-2 text-sm" style={inputStyle}>
            {implementations.map(i => (
              <option key={i.id} value={i.id}>
                {i.displayName ?? i.id} — {i.kind}{i.type ? ` (${i.type})` : ' (any venue)'}
              </option>
            ))}
          </select>
          <select value={credential} onChange={(e) => setCredential(e.target.value)} className="rounded-md px-3 py-2 text-sm" style={inputStyle}>
            <option value="">bind credential later (inactive)</option>
            {eligibleCredentials.map(c => <option key={c.id} value={c.name}>{c.name} ({c.type})</option>)}
          </select>
          <button type="submit" disabled={busy || !implId} className="px-4 py-2 rounded-md text-sm" style={{ background: 'var(--accent)', color: '#fff', opacity: busy ? 0.6 : 1 }}>
            Create
          </button>
        </div>
        {impl && eligibleCredentials.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--warning, #eab308)' }}>
            No eligible credential for {impl.type ?? impl.kind} — add one on the Credentials page, or create the account unbound.
          </p>
        )}
      </form>
    </div>
  )
}
