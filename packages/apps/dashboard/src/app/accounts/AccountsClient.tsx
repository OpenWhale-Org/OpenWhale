'use client'

import { useState } from 'react'
import type { AccountView, AccountImplementationInfo, AccountSnapshotRecord, CredentialInfo, CredentialTypeInfo } from '@openwhaleorg/core'
import { EquityChart } from './EquityChart'
import { AccountDetail } from './AccountDetail'
import { CredentialMark } from '@/components/TypeMark'

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
  /** Which account the right pane is showing. */
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showNew, setShowNew] = useState(false)
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
      // Land on what was just created, with the form put away — otherwise the
      // pane still shows the form and the new account is somewhere in the rail.
      setExpanded(name)
      setShowNew(false)
      setName(''); setCredential('')
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  /** After deleting, fall to whatever is left rather than an empty pane. */
  function afterRemoved(gone: string) {
    if (expanded !== gone) return
    const next = accounts.find(a => a.name !== gone)
    setExpanded(next?.name ?? null)
  }

  async function remove(accountName: string) {
    setError('')
    const res = await fetch(`/api/accounts/${encodeURIComponent(accountName)}`, { method: 'DELETE' })
    if (!res.ok) {
      setError(((await res.json()) as { error?: string }).error ?? 'delete failed')
      return
    }
    afterRemoved(accountName)
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

  const selected = accounts.find(a => a.name === (expanded ?? accounts[0]?.name))
  const totalEquity = accounts.reduce((sum, a) => sum + (snapshots[a.name]?.equity ?? 0), 0)

  const rebindableFor = (a: AccountView) => credentials.filter((c) => {
    const ai = implementations.find(i => i.id === a.implementation)
    if (!ai) return false
    if (ai.type !== undefined) return c.type === ai.type
    const typeInfo = credentialTypes.find(t => t.type === c.type)
    return typeInfo?.kinds.includes(ai.kind) ?? false
  })

  const statusStyle = (status: AccountView['status']) => ({
    background: status === 'ready' ? 'color-mix(in srgb, var(--success, #22c55e) 15%, transparent)'
      : status === 'inactive' ? 'color-mix(in srgb, var(--warning, #eab308) 15%, transparent)'
      : 'color-mix(in srgb, var(--danger, #ef4444) 15%, transparent)',
    color: status === 'ready' ? 'var(--success, #22c55e)'
      : status === 'inactive' ? 'var(--warning, #eab308)'
      : 'var(--danger, #ef4444)',
  })

  /* Two panes, the shape a wallet uses: the roster on the left stays put while
     the right pane changes. The table this replaced put a whole account's
     equity curve, balances, positions and orders inside an expanded <tr>,
     which meant reading one account pushed every other one off the screen. */
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <div className="px-4 py-2 rounded-md text-sm" style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      <div className="flex gap-3" style={{ height: 'calc(100vh - 13rem)', minHeight: 460 }}>
        {/* ── roster ─────────────────────────────────────────────────────── */}
        <div
          className="flex flex-col rounded-lg overflow-hidden shrink-0"
          style={{ width: '20rem', background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <div className="px-3 py-2.5 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="text-xs" style={{ color: 'var(--muted)' }}>Total equity · {accounts.length} accounts</div>
            <div className="text-xl font-mono mt-0.5">{formatUsd(totalEquity)}</div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
            {accounts.length === 0 && (
              <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>
                No accounts yet. Strategies read accounts; executors write them.
              </p>
            )}
            {accounts.map((a) => {
              const active = selected?.name === a.name
              const latest = snapshots[a.name]
              return (
                <button
                  key={a.name}
                  onClick={() => setExpanded(a.name)}
                  className="hoverable hoverable-flat w-full text-left px-3 py-2.5 flex items-center gap-2.5"
                  style={{
                    background: active ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'transparent',
                    borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                    borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)',
                  }}
                >
                  <CredentialMark
                    credential={a.credential}
                    credentials={credentials}
                    credentialTypes={credentialTypes}
                    size={26}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate" title={a.name}>{a.name}</div>
                    <div className="text-xs truncate" style={{ color: 'var(--muted)' }}>
                      {a.kind ?? '—'}{a.type ? ` · ${a.type}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-sm font-mono">
                      {latest ? formatUsd(latest.equity) : <span style={{ color: 'var(--muted)' }}>—</span>}
                    </div>
                    {a.status !== 'ready' && (
                      <span className="text-xs px-1.5 rounded-full" style={statusStyle(a.status)}>{a.status}</span>
                    )}
                    {a.snapshotError && (
                      <span className="text-xs ml-1 cursor-help" style={{ color: 'var(--danger, #ef4444)' }} title={`Last snapshot failed: ${a.snapshotError}`}>⚠</span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>

          <div className="shrink-0 flex gap-2 px-3 py-2.5" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              data-tour="new-account"
              onClick={() => setShowNew(v => !v)}
              className="flex-1 h-8 rounded-md text-xs flex items-center justify-center gap-1.5"
              style={{ background: showNew ? 'var(--background)' : 'var(--accent)', color: showNew ? 'var(--foreground)' : '#fff', border: showNew ? '1px solid var(--border)' : 'none' }}
            >
              {showNew ? 'Cancel' : '＋ New account'}
            </button>
            <button
              onClick={() => void sampleNow()}
              disabled={busy}
              className="h-8 px-2.5 rounded-md text-xs"
              style={{ border: '1px solid var(--border)', color: 'var(--muted)', opacity: busy ? 0.6 : 1 }}
              title="Take an equity snapshot of every account right now (normally sampled every 5 minutes)"
            >
              {busy ? '…' : '⟳'}
            </button>
          </div>
        </div>

        {/* ── detail ─────────────────────────────────────────────────────── */}
        <div
          className="flex-1 min-w-0 rounded-lg overflow-hidden flex flex-col"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          {showNew ? (
            <form data-tour="account-form" onSubmit={create} className="flex flex-col gap-3 p-4">
              <h2 className="text-sm font-semibold">New Account</h2>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Account name, e.g. BN-Main-Perp"
                className="rounded-md px-3 py-2 text-sm"
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
              {impl && eligibleCredentials.length === 0 && (
                <p className="text-xs" style={{ color: 'var(--warning, #eab308)' }}>
                  No eligible credential for {impl.type ?? impl.kind} — add one on the Credentials page, or create the account unbound.
                </p>
              )}
              <button type="submit" disabled={busy || !implId} className="h-9 rounded-md text-sm self-start px-4" style={{ background: 'var(--accent)', color: '#fff', opacity: busy ? 0.6 : 1 }}>
                Create
              </button>
            </form>
          ) : !selected ? (
            <div className="flex-1 grid place-items-center text-sm" style={{ color: 'var(--muted)' }}>
              Pick an account.
            </div>
          ) : (
            <>
              <div className="px-4 py-3 shrink-0 flex items-start gap-3" style={{ borderBottom: '1px solid var(--border)' }}>
                <CredentialMark
                  credential={selected.credential}
                  credentials={credentials}
                  credentialTypes={credentialTypes}
                  size={34}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-base font-medium truncate">{selected.name}</span>
                    <span className="px-2 py-0.5 rounded-full text-xs shrink-0" style={statusStyle(selected.status)} title={selected.problem}>
                      {selected.status}{selected.problem ? ' ⓘ' : ''}
                    </span>
                  </div>
                  <div className="text-xs font-mono mt-0.5 truncate" style={{ color: 'var(--muted)' }}>
                    {selected.implementation} · {selected.kind ?? '—'}{selected.type ? ` · ${selected.type}` : ''}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-2xl font-mono">
                    {snapshots[selected.name] ? formatUsd(snapshots[selected.name]!.equity) : '—'}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--muted)' }}>equity</div>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden px-4 py-3 flex flex-col gap-4">
                <EquityChart account={selected.name} />
                {selected.status === 'ready' && <AccountDetail account={selected.name} />}
              </div>

              <div className="shrink-0 flex items-center gap-2 px-4 py-2.5" style={{ borderTop: '1px solid var(--border)' }}>
                <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>Credential</span>
                <select
                  value={selected.credential ?? ''}
                  onChange={(e) => rebind(selected, e.target.value)}
                  className="rounded-md px-2 h-8 text-xs flex-1 min-w-0"
                  style={inputStyle}
                >
                  <option value="">— unbound —</option>
                  {rebindableFor(selected).map(c => <option key={c.id} value={c.name}>{c.name} ({c.type})</option>)}
                </select>
                <button
                  onClick={() => remove(selected.name)}
                  className="h-8 px-3 rounded-md text-xs shrink-0"
                  style={{ color: 'var(--danger, #ef4444)', border: '1px solid var(--border)' }}
                >
                  Delete
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
