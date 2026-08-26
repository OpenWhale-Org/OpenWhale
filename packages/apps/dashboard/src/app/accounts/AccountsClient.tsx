'use client'

import { useEffect, useMemo, useState } from 'react'
import { Rail, RailItem } from '../../components/Rail'
import { Select } from '../../components/Select'
import { KebabMenu, MENU_ITEM } from '../../components/CardMenu'
import { useSortable, DragHandle } from '../../components/Sortable'
import type { AccountView, AccountImplementationInfo, AccountSnapshotRecord, CredentialInfo, CredentialTypeInfo } from '@openwhaleorg/core'
import { EquityChart } from './EquityChart'
import { AccountDetail } from './AccountDetail'
import { AccountPicker, eligibleCredentialsFor } from './AccountPicker'
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

/* ── Roster order ─────────────────────────────────────────────────────────
   Manual order and the chosen sort both live in localStorage: this is a
   viewer's preference about their own screen, not a property of the account. */
type SortMode = 'manual' | 'equity' | 'name'
const SORT_KEY = 'ow.accounts.sort'
const ORDER_KEY = 'ow.accounts.order'
const SORT_LABEL: Record<SortMode, string> = { manual: 'Manual', equity: 'Equity ↓', name: 'Name A–Z' }

function readSort(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY)
    return v === 'equity' || v === 'name' || v === 'manual' ? v : 'manual'
  } catch { return 'manual' }
}
function readOrder(): string[] {
  try { return JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as string[] } catch { return [] }
}

/* ── Sparkline ────────────────────────────────────────────────────────────
   The last day of equity as a thumbnail in the roster row, so the list already
   says which accounts moved before any of them is opened. */
function Sparkline({ account, tick, width, height }: { account: string; tick: number; width: number; height: number }) {
  const [series, setSeries] = useState<AccountSnapshotRecord[] | null>(null)
  useEffect(() => {
    let alive = true
    void fetch(`/api/accounts/${encodeURIComponent(account)}/snapshots?hours=24`)
      .then(r => (r.ok ? r.json() : []) as Promise<AccountSnapshotRecord[]>)
      .then(s => { if (alive) setSeries(s) })
      .catch(() => { if (alive) setSeries([]) })
    return () => { alive = false }
  }, [account, tick])
  const W = width, H = height
  if (!series || series.length < 2) return null
  const ys = series.map(s => s.equity)
  const min = Math.min(...ys), max = Math.max(...ys)
  const span = max - min || 1
  const t0 = series[0]!.ts, t1 = series[series.length - 1]!.ts, dt = t1 - t0 || 1
  const xy = series.map(s => [((s.ts - t0) / dt) * W, H - 3 - ((s.equity - min) / span) * (H - 8)] as const)
  const line = xy.map(([x, y]) => `${x},${y}`).join(' ')
  const area = `M0,${H} L${line.replace(/ /g, ' L')} L${W},${H} Z`
  const up = ys[ys.length - 1]! >= ys[0]!
  const color = up ? 'var(--success, #22c55e)' : 'var(--danger, #ef4444)'
  const gid = `spark-${account.replace(/[^a-z0-9]/gi, '_')}`
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden className="absolute inset-y-0 right-0 pointer-events-none" style={{ opacity: 0.45 }}>
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

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
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** Bumped after a snapshot so every sparkline refetches. */
  const [sparkTick, setSparkTick] = useState(0)
  const [sort, setSort] = useState<SortMode>('manual')
  const [order, setOrder] = useState<string[]>([])
  useEffect(() => { setSort(readSort()); setOrder(readOrder()) }, [])

  function changeSort(mode: SortMode) {
    setSort(mode)
    try { localStorage.setItem(SORT_KEY, mode) } catch { /* private mode */ }
  }
  function saveOrder(next: string[]) {
    setOrder(next)
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)) } catch { /* private mode */ }
  }

  const ordered = useMemo(() => {
    const list = [...accounts]
    if (sort === 'equity') return list.sort((a, b) => (snapshots[b.name]?.equity ?? -Infinity) - (snapshots[a.name]?.equity ?? -Infinity))
    if (sort === 'name') return list.sort((a, b) => a.name.localeCompare(b.name))
    // Manual: remembered order first, newcomers after in creation order.
    const rank = new Map(order.map((n, i) => [n, i]))
    return list.sort((a, b) => (rank.get(a.name) ?? Infinity) - (rank.get(b.name) ?? Infinity))
  }, [accounts, sort, order, snapshots])

  // Drag rows in manual mode. Rows are "folders" to the hook: a short
  // vertical list hit-tested by the element under the cursor.
  const { beginDrag, folderStyle } = useSortable({
    onReorder: () => {},
    onRefile: () => {},
    onFolderMove: (dragName, targetName) => {
      const names = ordered.map(a => a.name)
      const from = names.indexOf(dragName), to = names.indexOf(targetName)
      if (from < 0 || to < 0) return
      names.splice(from, 1); names.splice(to, 0, dragName)
      saveOrder(names)
    },
  })

  async function refresh() {
    const res = await fetch('/api/accounts')
    if (res.ok) {
      const data = await res.json() as { accounts: AccountView[]; snapshots: Record<string, AccountSnapshotRecord> }
      setAccounts(data.accounts)
      setSnapshots(data.snapshots)
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
      body: JSON.stringify({ name: account.name, implementation: account.implementation, ...(credentialName ? { credential: credentialName } : {}), ...(account.params !== undefined ? { params: account.params } : {}) }),
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
        setSparkTick(t => t + 1)
        const failed = data.accounts.filter(a => a.snapshotError)
        if (failed.length > 0) {
          setError(failed.map(a => `${a.name}: ${a.snapshotError}`).join(' · '))
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const selected = accounts.find(a => a.name === (expanded ?? ordered[0]?.name))
  /* Holds the NAME being confirmed, not a boolean: an account carries its
     equity history and its bindings, so arming Delete on one and then
     switching to another must not leave the next account one click from
     gone. Keying it by name makes changing the selection disarm it. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const totalEquity = accounts.reduce((sum, a) => sum + (snapshots[a.name]?.equity ?? 0), 0)

  const rebindableFor = (a: AccountView) => eligibleCredentialsFor(implementations.find(i => i.id === a.implementation), credentials, credentialTypes)

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

      {showNew && (
        <AccountPicker
          implementations={implementations}
          credentials={credentials}
          credentialTypes={credentialTypes}
          onClose={() => setShowNew(false)}
          onCreated={async (name) => {
            // Land on what was just created — otherwise the new account is
            // somewhere in the rail and the pane still shows the old one.
            setShowNew(false)
            setExpanded(name)
            await refresh()
          }}
        />
      )}

      <div className="flex gap-3" style={{ height: 'calc(100vh - 13rem)', minHeight: 460 }}>
        {/* ── roster ─────────────────────────────────────────────────────── */}
        <Rail
          width="21rem"
          header={
            <div className="px-3 py-2.5 flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-xs" style={{ color: 'var(--muted)' }}>Total equity · {accounts.length} accounts</div>
                <div className="text-xl font-mono mt-0.5">{formatUsd(totalEquity)}</div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{SORT_LABEL[sort]}</span>
                <KebabMenu title="Sort">
                  {(close) => (
                    <>
                      <div className="px-3 pt-1.5 pb-1 text-xs" style={{ color: 'var(--muted)' }}>SORT</div>
                      {(Object.keys(SORT_LABEL) as SortMode[]).map(m => (
                        <button key={m} type="button" className={`${MENU_ITEM} flex items-center gap-2`} style={{ color: 'var(--foreground)' }}
                          onClick={() => { changeSort(m); close() }}>
                          <span style={{ color: m === sort ? 'var(--accent)' : 'var(--muted)' }}>{m === sort ? '●' : '○'}</span>
                          {SORT_LABEL[m]}
                          {m === 'manual' && <span className="ml-auto text-[11px]" style={{ color: 'var(--muted)' }}>drag rows</span>}
                        </button>
                      ))}
                    </>
                  )}
                </KebabMenu>
              </div>
            </div>
          }
          footer={
            <div className="flex gap-2 px-3 py-2.5">
              <button
                data-tour="new-account"
                onClick={() => setShowNew(true)}
                className="flex-1 h-8 rounded-md text-xs flex items-center justify-center gap-1.5"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                ＋ New account
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
          }
        >
          {accounts.length === 0 && (
            <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>
              No accounts yet. Strategies read accounts; executors write them.
            </p>
          )}
          {ordered.map((a) => {
            const latest = snapshots[a.name]
            return (
              <div key={a.name} data-folder-id={a.name} style={folderStyle(a.name)} className="flex items-stretch">
                <div className="flex-1 min-w-0">
                  <RailItem
                    active={selected?.name === a.name}
                    onClick={() => setExpanded(a.name)}
                    mark={<CredentialMark credential={a.credential} credentials={credentials} credentialTypes={credentialTypes} size={26} />}
                    title={a.name}
                    subtitle={`${a.kind ?? '—'}${a.type ? ` · ${a.type}` : ''}`}
                    right={
                      /* The last day of equity sits behind the figure, faded:
                         a wash of colour that says "moved up / moved down"
                         without competing with the number on top of it. */
                      <span className="relative flex flex-col items-end justify-center gap-0.5" style={{ minWidth: 120, minHeight: 34 }}>
                        <Sparkline account={a.name} tick={sparkTick} width={120} height={34} />
                        <span className="relative text-sm font-mono" style={{ color: latest ? 'var(--foreground)' : 'var(--muted)' }}>{latest ? formatUsd(latest.equity) : '—'}</span>
                        {a.status !== 'ready' && <span className="relative text-[11px] px-1.5 rounded-full" style={statusStyle(a.status)}>{a.status}</span>}
                        {a.snapshotError && <span className="relative cursor-help" style={{ color: 'var(--danger)' }} title={`Last snapshot failed: ${a.snapshotError}`}>⚠</span>}
                      </span>
                    }
                  />
                </div>
                {sort === 'manual' && (
                  <span className="flex items-center pr-1" style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                    <DragHandle title="Drag to reorder" onPointerDown={(e) => beginDrag('folder', a.name, e)} />
                  </span>
                )}
              </div>
            )
          })}
        </Rail>

        {/* ── detail ─────────────────────────────────────────────────────── */}
        <div
          className="flex-1 min-w-0 rounded-lg overflow-hidden flex flex-col"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          {!selected ? (
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
                <Select
                  size="sm"
                  className="flex-1 min-w-0"
                  value={selected.credential ?? ''}
                  onChange={(v) => void rebind(selected, v)}
                  options={[
                    { value: '', label: '— unbound —' },
                    ...rebindableFor(selected).map(c => ({
                      value: c.name, label: c.name, hint: c.type,
                      mark: <CredentialMark credential={c.name} credentials={credentials} credentialTypes={credentialTypes} size={18} />,
                    })),
                  ]}
                />
                <button
                  onClick={() => {
                    if (confirmDelete !== selected.name) { setConfirmDelete(selected.name); return }
                    setConfirmDelete(null)
                    void remove(selected.name)
                  }}
                  // Armed state does not outlive the pointer — a red button
                  // left primed is a trap for whoever comes back to the page
                  onMouseLeave={() => setConfirmDelete(null)}
                  className="h-8 px-3 rounded-md text-xs shrink-0"
                  style={confirmDelete === selected.name
                    ? { color: '#fff', background: 'var(--danger, #ef4444)', border: '1px solid var(--danger, #ef4444)' }
                    : { color: 'var(--danger, #ef4444)', border: '1px solid var(--border)' }}
                >
                  {confirmDelete === selected.name ? 'Delete for good?' : 'Delete'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
