'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { useSearchParams } from 'next/navigation'
import { Rail, RailGroup, RailItem, StatusDot } from '../../components/Rail'
import type { MonitorDefinition, ParamFieldCatalogue, MonitorInstanceView, CredentialInfo } from '@openwhaleorg/core'
import { subscribeLiveEvents } from '@/lib/live-events'
import { MonitorBoards } from './MonitorBoards'
import { MonitorInstancesPanel, type ImplementationInfo } from './MonitorInstancesPanel'
import { LogsPanel } from '@/components/LogsPanel'
import { Modal } from '@/components/Modal'
import { JsonModal, CopyButton } from '@/components/JsonModal'
import { SymbolPicker } from '@/components/SymbolPicker'

interface SseEvent {
  type: string
  monitor: string
  key: string
  data: unknown
  ts: number
}

interface MonitorStatus {
  id: string
  name: string
  description?: string
  mode: string
  activeKeys: Array<{ key: string; refCount: number }>
  wildcardSubscribers: number
  /** This monitor reconstructs history on a key's first subscribe. */
  supportsBackfill?: boolean
  /** Keys whose history is landing right now — live collection starts after. */
  backfillingKeys?: string[]
  manualKeys: string[]
  keyFields?: Array<{ name: string; displayName: string; type: string; placeholder?: string; description?: string; default?: unknown; options?: Array<{ label: string; value: unknown }>; catalogue?: ParamFieldCatalogue }>
  dataKeys: string[]
}

interface MonitorRecord {
  ts: number
  data: unknown
}

interface Props {
  monitors: MonitorDefinition[]
  /** Instance data, server-rendered; refetched client-side whenever anything changes. */
  instances: MonitorInstanceView[]
  implementations: ImplementationInfo[]
  pendingKeys: Record<string, string[]>
  credentials: CredentialInfo[]
}

/** 'exchange/ticker' → { pkg: 'exchange', short: 'ticker' } */
function splitId(id: string): { pkg: string; short: string } {
  const idx = id.indexOf('/')
  return idx === -1 ? { pkg: 'core', short: id } : { pkg: id.slice(0, idx), short: id.slice(idx + 1) }
}

export function MonitorClient({ monitors, instances: initialInstances, implementations, pendingKeys: initialPending, credentials }: Props) {
  const [statuses, setStatuses] = useState<MonitorStatus[]>([])
  const [instances, setInstances] = useState(initialInstances)
  const [pendingKeys, setPendingKeys] = useState(initialPending)
  // Deep link from an instance's event row: /monitor?sel=<monitor id>
  const preselect = useSearchParams().get('sel')
  const [selectedId, setSelectedId] = useState<string | null>(preselect)
  const [events, setEvents] = useState<SseEvent[]>([])
  const [connected, setConnected] = useState(false)

  /**
   * Statuses and instances refresh TOGETHER: activating an instance changes
   * which keys a monitor serves, so refetching one without the other leaves
   * the header claiming keys the panel says nothing is serving.
   */
  const refresh = useCallback(async () => {
    const [statusRes, instRes] = await Promise.all([
      fetch('/api/monitor/status'),
      fetch('/api/monitor-instances'),
    ])
    if (statusRes.ok) {
      const next = await statusRes.json() as MonitorStatus[]
      setStatuses(next)
      setSelectedId((prev) => prev ?? next[0]?.id ?? null)
    }
    if (instRes.ok) {
      const data = await instRes.json() as { instances: MonitorInstanceView[]; pendingKeys: Record<string, string[]> }
      setInstances(data.instances)
      setPendingKeys(data.pendingKeys)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    return subscribeLiveEvents(
      (data) => {
        const event = data as SseEvent
        if (event.type !== 'monitor_emit') return
        setEvents((prev) => [event, ...prev].slice(0, 300))
      },
      setConnected,
    )
  }, [])

  const selected = statuses.find(s => s.id === selectedId) ?? null

  // Group by package prefix
  const groups = new Map<string, MonitorStatus[]>()
  for (const s of statuses) {
    const { pkg } = splitId(s.id)
    if (!groups.has(pkg)) groups.set(pkg, [])
    groups.get(pkg)!.push(s)
  }

  return (
    <div className="flex gap-3" style={{ height: 'calc(100vh - 13rem)', minHeight: 460 }}>
      {/* ── Left: monitors grouped by package ── */}
      <Rail width="18rem">
        {statuses.length === 0 && monitors.length === 0 && (
          <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>No monitors registered.</p>
        )}
        {[...groups.entries()].map(([pkg, items]) => (
          <RailGroup key={pkg} label={pkg} count={items.length}>
            {items.map((m) => {
              /* Two independent facts as two marks: RUNNING = an instance of
                 this contract is activated; SUBSCRIBED = keys are being
                 watched. A monitor can run with nothing subscribed, or have
                 subscriptions nothing serves — that second case is the silent
                 failure the dot/badge pair exposes. */
              const mine = instances.filter(i => i.contract === m.id)
              const running = mine.filter(i => i.active).length
              return (
                <RailItem
                  key={m.id}
                  active={m.id === selectedId}
                  onClick={() => setSelectedId(m.id)}
                  mark={mine.length > 0
                    ? <StatusDot color={running > 0 ? 'var(--success)' : 'var(--muted)'} title={running > 0 ? `${running} of ${mine.length} instance${mine.length > 1 ? 's' : ''} running` : `${mine.length} instance${mine.length > 1 ? 's' : ''}, none running`} />
                    : <StatusDot color="transparent" />}
                  title={splitId(m.id).short}
                  subtitle={m.description}
                  right={m.activeKeys.length > 0
                    ? <span className="px-1.5 rounded-full text-[11px]" style={{ background: 'var(--accent)', color: '#fff' }} title={`${m.activeKeys.length} key${m.activeKeys.length > 1 ? 's' : ''} subscribed`}>{m.activeKeys.length}</span>
                    : undefined}
                />
              )
            })}
          </RailGroup>
        ))}
      </Rail>

      {/* ── Right: selected monitor detail ── */}
      <main className="flex-1 min-w-0">
        {selected ? (
          <MonitorDetail
            key={selected.id}
            status={selected}
            events={events.filter(e => e.monitor === selected.id)}
            connected={connected}
            onChanged={() => void refresh()}
            instances={instances}
            implementations={implementations}
            pendingKeys={pendingKeys}
            credentials={credentials}
          />
        ) : (
          <p className="text-sm p-8 text-center" style={{ color: 'var(--muted)' }}>Select a monitor.</p>
        )}
      </main>
    </div>
  )
}

// ── Detail ────────────────────────────────────────────────────────────────────

function MonitorDetail({ status, events, connected, onChanged, instances, implementations, pendingKeys, credentials }: {
  status: MonitorStatus
  events: SseEvent[]
  connected: boolean
  onChanged: () => void
  instances: MonitorInstanceView[]
  implementations: ImplementationInfo[]
  pendingKeys: Record<string, string[]>
  credentials: CredentialInfo[]
}) {
  /* Board is what you open this page FOR; Manage is the plumbing you set up
     once. Both can be on screen (Split), but Board is the default alone. */
  const [view, setView] = useState<'board' | 'split' | 'manage'>(() => {
    try { return (localStorage.getItem('ow.monitor.view') as 'board' | 'split' | 'manage') || 'board' } catch { return 'board' }
  })
  const [splitPct, setSplitPct] = useState<number>(() => {
    try { return Number(localStorage.getItem('ow.monitor.split')) || 60 } catch { return 60 }
  })
  const areaRef = useRef<HTMLDivElement>(null)
  function pickView(v: 'board' | 'split' | 'manage') {
    setView(v)
    try { localStorage.setItem('ow.monitor.view', v) } catch { /* private mode */ }
  }
  function startDrag(e: React.MouseEvent) {
    e.preventDefault()
    const rect = areaRef.current?.getBoundingClientRect()
    if (!rect) return
    const move = (ev: MouseEvent) => setSplitPct(Math.min(80, Math.max(30, ((ev.clientX - rect.left) / rect.width) * 100)))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setSplitPct(p => { try { localStorage.setItem('ow.monitor.split', String(Math.round(p))) } catch { /* private mode */ } return p })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const showBoard = view !== 'manage'
  const showManage = view !== 'board'
  const [watching, setWatching] = useState(false)
  const mine = instances.filter(i => i.contract === status.id)

  /* key -> the strategy instances that subscribe it.
     The monitor itself only keeps a refcount — `subscribe(key)` carries no
     identity — so this is derived the other way round, from each strategy's
     own declared scope. Fetched once per selected monitor, and only used to
     label; nothing depends on it being complete. */
  const [subscribers, setSubscribers] = useState<Record<string, string[]>>({})
  useEffect(() => {
    let gone = false
    void fetch('/api/instances')
      .then(r => r.ok ? r.json() as Promise<Array<{ id: string; name: string }>> : [])
      .then(async (list) => {
        const out: Record<string, string[]> = {}
        await Promise.all(list.map(async (inst) => {
          const r = await fetch(`/api/instances/${inst.id}/scope`).catch(() => null)
          if (!r?.ok) return
          const scope = (await r.json()) as { monitors: Array<{ monitor: string; key: string }> }
          for (const m of scope.monitors) {
            if (m.monitor !== status.id) continue
            ;(out[m.key] ??= []).push(inst.name)
          }
        }))
        if (!gone) setSubscribers(out)
      })
      .catch(() => { /* labels only */ })
    return () => { gone = true }
  }, [status.id])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function unwatch(key: string) {
    setBusy(true)
    setError('')
    const res = await fetch(`/api/monitor/${encodeURIComponent(status.id)}/watch`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    })
    setBusy(false)
    if (!res.ok) setError(await res.text())
    else onChanged()
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start gap-2 flex-wrap">
        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto scroll-hidden">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{status.id}</h2>
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
              {status.mode}
            </span>
            {status.wildcardSubscribers > 0 && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>wildcard ×{status.wildcardSubscribers}</span>
            )}
            {status.supportsBackfill && (
              <span
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
                title="Reconstructs history from the venue on a key's first subscribe, incrementally from what is already stored"
              >
                backfill
              </span>
            )}
          </div>
          {status.description && <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>{status.description}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {([['board', 'Board'], ['split', 'Split'], ['manage', 'Manage']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => pickView(key)}
              className="text-[11px] px-2.5 py-1"
              style={{
                background: view === key ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
                color: view === key ? 'var(--foreground)' : 'var(--muted)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>{mine.length} inst · {status.activeKeys.length} watched</span>
      </div>

      {/* Two tabs, not a stack of boxes.
          Board is what you open this page FOR: the charts, what is being
          collected, and what just arrived. Manage is the plumbing behind it —
          runners and subscriptions — which you set up once and then leave
          alone. Giving them equal billing on one screen is what made this page
          hard to read; the charts were a band in the middle of five forms. */}

      <div ref={areaRef} className="flex items-start">
      {showBoard && (
        <div className="flex flex-col gap-3 min-w-0" style={{ flexBasis: showManage ? `${splitPct}%` : '100%', flexGrow: 0, flexShrink: 0 }}>
          <MonitorBoards
            monitorId={status.id}
            keys={Array.from(new Set([...status.activeKeys.map(k => k.key), ...status.manualKeys, ...status.dataKeys]))}
            emitCount={events.length}
          />

        </div>
      )}
      {showBoard && showManage && (
        <div onMouseDown={startDrag} className="shrink-0 cursor-col-resize grid place-items-center self-stretch mx-1" style={{ width: 8, minHeight: 200 }} title="Drag to resize">
          <div className="w-0.5 h-8 rounded-full" style={{ background: 'var(--muted)', opacity: 0.6 }} />
        </div>
      )}
      {showManage && (
        <div className="flex flex-col gap-3 flex-1 min-w-0">
          <MonitorInstancesPanel
            contract={status.id}
            instances={instances}
            implementations={implementations}
            pendingKeys={pendingKeys}
            credentials={credentials}
            onChanged={onChanged}
          />

          <section className="rounded-lg p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
                SUBSCRIPTIONS ({status.activeKeys.length})
              </span>
              <button
                onClick={() => setWatching(true)}
                className="hoverable hoverable-flat ml-auto h-8 px-2.5 rounded-md text-xs"
                style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
              >
                ＋ Watch a key
              </button>
            </div>

            {status.backfillingKeys && status.backfillingKeys.length > 0 && (
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Backfilling {status.backfillingKeys.join(', ')} — live collection starts when it lands.
              </p>
            )}

            {status.activeKeys.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Nothing subscribed. A strategy instance subscribes what it needs when it activates;
                use Watch to collect a key without one.
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {status.activeKeys.map(({ key: k, refCount }) => {
                  const manual = status.manualKeys.includes(k)
                  /* A blank key means a subscription's structured keyParams never
                     got composed into a key, so it is subscribed to nothing and
                     collects nothing — silently. Hiding these rows was how that
                     bug survived a day of live cycles; the blank chip is the only
                     visible symptom, so it is called out rather than filtered. */
                  const unresolved = k.trim().length === 0
                  const by = subscribers[k] ?? []
                  return (
                    <div
                      key={k}
                      className="hoverable hoverable-flat rounded-md px-3 py-2 flex items-center gap-3"
                      style={{ background: 'var(--background)', border: `1px solid ${unresolved ? 'var(--danger)' : 'var(--border)'}` }}
                    >
                      <span className="font-mono text-xs min-w-0 flex-1 truncate" style={unresolved ? { color: 'var(--danger)' } : undefined}>
                        {unresolved ? '⚠ unresolved key' : k}
                      </span>
                      <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
                        {by.length > 0 ? by.join(' · ') : manual ? 'manual watch' : `×${refCount}`}
                      </span>
                      {manual && (
                        <button
                          onClick={() => void unwatch(k)}
                          disabled={busy}
                          className="text-xs shrink-0 h-6 px-2 rounded-md"
                          style={{ color: 'var(--danger)', border: '1px solid var(--border)' }}
                          title="Stop this manual watch"
                        >
                          Unwatch
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
            {error && <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</p>}
          </section>

          {/* What is being collected, and when it last spoke. */}
          <KeyStrip
            status={status}
            events={events}
            connected={connected}
            subscribers={subscribers}
          />

          <details className="rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <summary className="px-3 py-2 text-xs cursor-pointer flex items-center gap-2" style={{ color: 'var(--muted)' }}>
              <span className="w-2 h-2 rounded-full" style={{ background: connected ? 'var(--success)' : 'var(--danger)' }} />
              Live feed · {events.length} emits
            </summary>
            <div className="max-h-80 overflow-y-auto scroll-hidden font-mono text-xs" style={{ borderTop: '1px solid var(--border)' }}>
              {events.length === 0 ? (
                <p className="p-4" style={{ color: 'var(--muted)' }}>Waiting for emits…</p>
              ) : events.map((event, i) => (
                <div key={`${event.ts}-${i}`} className="px-3 py-2 flex gap-3 items-start" style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                  <span className="shrink-0 opacity-60" style={{ color: 'var(--muted)' }}>{new Date(event.ts).toLocaleTimeString()}</span>
                  <span className="shrink-0" style={{ color: 'var(--warning)' }}>{event.key}</span>
                  <DataView data={event.data} />
                </div>
              ))}
            </div>
          </details>

          <details className="rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <summary className="px-3 py-2 text-xs cursor-pointer flex items-center gap-2" style={{ color: 'var(--muted)' }}>
              <span className="w-2 h-2 rounded-full" style={{ background: 'var(--muted)' }} />
              Logs
            </summary>
            <div style={{ borderTop: '1px solid var(--border)' }}>
              <LogsPanel id={status.id} logsUrl={`/api/monitor/${encodeURIComponent(status.id)}/logs?n=200`} sseType="monitor_log" />
            </div>
          </details>
        </div>
      )}
      </div>

      {watching && (
        <Modal onClose={() => setWatching(false)} maxWidth="34rem">
          <div className="flex items-center gap-2 px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <h2 className="font-semibold text-base flex-1">Watch a key</h2>
            <button type="button" onClick={() => setWatching(false)} className="w-7 h-7 rounded-md flex items-center justify-center" style={{ color: 'var(--muted)' }} aria-label="Close">✕</button>
          </div>
          <div className="px-5 py-4 flex flex-col gap-3">
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Collects this key without a strategy asking for it. An instance of {status.id} has to
              be running to serve it.
            </p>
            <WatchForm status={status} onChanged={() => { setWatching(false); onChanged() }} />
          </div>
        </Modal>
      )}
    </div>
  )
}

/** One of the two top-level tabs. */

/**
 * What is being collected, and when each key last spoke.
 *
 * The "last seen" comes from the live feed, so it fills in as emits arrive
 * rather than claiming a freshness it has not observed. Each key links into
 * the Explorer, which is where you go when the chart looks wrong and you want
 * the raw records.
 */
function KeyStrip({ status, events, connected, subscribers }: {
  status: MonitorStatus
  events: SseEvent[]
  connected: boolean
  subscribers: Record<string, string[]>
}) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [records, setRecords] = useState<{ key: string; total: number; rows: Array<{ ts: number; data: unknown }> } | null>(null)
  const [loading, setLoading] = useState(false)

  const lastSeen = new Map<string, number>()
  for (const e of events) if (!lastSeen.has(e.key)) lastSeen.set(e.key, e.ts)

  const keys = Array.from(new Set([...status.activeKeys.map(k => k.key), ...status.dataKeys])).filter(k => k.trim())

  async function toggle(k: string) {
    if (openKey === k) { setOpenKey(null); return }
    setOpenKey(k)
    setLoading(true)
    try {
      const res = await fetch(`/api/monitor/${encodeURIComponent(status.id)}/${encodeURIComponent(k)}?n=20`)
      const body = res.ok ? await res.json() as { records: Array<{ ts: number; data: unknown }>; total: number } : { records: [], total: 0 }
      setRecords({ key: k, total: body.total, rows: [...body.records].reverse() })
    } finally {
      setLoading(false)
    }
  }

  if (keys.length === 0) return null

  return (
    <div className="rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="px-3 py-2 flex items-center gap-2 flex-wrap">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: connected ? 'var(--success)' : 'var(--danger)' }} title={connected ? 'Live stream connected' : 'Live stream disconnected'} />
        {keys.map((k) => {
          const running = status.activeKeys.some(a => a.key === k)
          const seen = lastSeen.get(k)
          const by = subscribers[k] ?? []
          const open = openKey === k
          return (
            <button
              key={k}
              type="button"
              onClick={() => void toggle(k)}
              className="hoverable hoverable-flat rounded-md px-2 py-1 flex items-center gap-2 text-xs"
              style={{
                background: open ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'var(--background)',
                border: `1px solid ${open || running ? 'var(--accent)' : 'var(--border)'}`,
              }}
              title={by.length > 0 ? `Subscribed by ${by.join(', ')} — click for recent events` : 'Click for recent events'}
            >
              <span className="font-mono">{k}</span>
              {by.length > 0 && <span style={{ color: 'var(--muted)' }}>{by.length === 1 ? by[0] : `${by.length} strategies`}</span>}
              <span style={{ color: 'var(--muted)' }}>
                {seen ? new Date(seen).toLocaleTimeString() : running ? 'waiting' : 'stored'}
              </span>
            </button>
          )
        })}
      </div>
      {openKey && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          <div className="px-3 py-1.5 flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <span className="font-mono">{openKey}</span>
            <span>· {loading ? 'loading…' : `last ${records?.rows.length ?? 0} of ${records?.total ?? 0} records`}</span>
            <a
              href={`/monitor-data?monitor=${encodeURIComponent(status.id)}&key=${encodeURIComponent(openKey)}`}
              className="ml-auto px-2 py-0.5 rounded-md"
              style={{ border: '1px solid var(--border)', color: 'var(--accent)' }}
            >
              Open in Explorer ↗
            </a>
          </div>
          <div className="max-h-72 overflow-y-auto scroll-hidden font-mono text-xs" style={{ borderTop: '1px solid var(--border)' }}>
            {!loading && records?.key === openKey && records.rows.length === 0 && (
              <p className="p-3" style={{ color: 'var(--muted)' }}>No stored records for this key yet.</p>
            )}
            {records?.key === openKey && records.rows.map((r, i) => (
              <div key={`${r.ts}-${i}`} className="px-3 py-2 flex gap-3 items-start" style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
                <span className="shrink-0 opacity-60" style={{ color: 'var(--muted)' }}>{new Date(r.ts).toLocaleTimeString()}</span>
                <DataView data={r.data} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Watch form (structured keySchema fields or raw key) ───────────────────────

/**
 * The venue a catalogue picker should query: the sibling field's current
 * value, falling back to what an untouched select actually DISPLAYS (schema
 * default, then first option) — otherwise the picker looks unset while the
 * form shows a venue.
 */
function resolveVenue(
  catalogue: ParamFieldCatalogue,
  fields: Array<{ name: string; default?: unknown; options?: Array<{ value: unknown }> }>,
  values: Record<string, string>,
): string | undefined {
  if (!catalogue.venueField) return undefined
  const typed = (values[catalogue.venueField] ?? '').trim()
  if (typed) return typed
  const field = fields.find(f => f.name === catalogue.venueField)
  if (!field) return undefined
  if (field.default !== undefined) return String(field.default)
  const first = field.options?.[0]
  return first ? String(first.value) : undefined
}

function WatchForm({ status, onChanged }: { status: MonitorStatus; onChanged: () => void }) {
  const [key, setKey] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const standalone = status.mode === 'standalone'
  const fields = status.keyFields

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError('')
    const res = await fetch(`/api/monitor/${encodeURIComponent(status.id)}/watch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    if (!res.ok) setError(await res.text())
    else { setKey(''); setFieldValues({}); onChanged() }
  }

  function watchStructured() {
    const params: Record<string, unknown> = {}
    for (const f of fields ?? []) {
      // Untouched selects display their first option while state stays '' —
      // submit must match what the user SEES: schema default, then first option.
      const raw = (fieldValues[f.name] ?? '').trim()
        || (f.default !== undefined ? String(f.default) : '')
        || (f.options?.[0] !== undefined ? String(f.options[0].value) : '')
      if (raw === '') continue
      params[f.name] = f.type === 'number' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw
    }
    void post({ params })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 flex-wrap items-end">
        {!standalone && fields && fields.length > 0 ? (
          <>
            {fields.map((f) => (
              <div key={f.name} className="flex flex-col gap-0.5">
                <label className="text-xs" style={{ color: 'var(--muted)' }} title={f.description}>
                  {f.displayName}
                </label>
                {f.options && f.options.length > 0 ? (
                  <select
                    value={fieldValues[f.name] ?? String(f.default ?? f.options[0]?.value ?? '')}
                    onChange={(e) => setFieldValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    title={f.description}
                    className="rounded-md px-2 py-1.5 text-xs font-mono"
                    style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                  >
                    {f.options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
                  </select>
                ) : f.catalogue ? (
                  <SymbolPicker
                    value={fieldValues[f.name] ?? ''}
                    onChange={(v) => setFieldValues((prev) => ({ ...prev, [f.name]: v }))}
                    // The venue lives in a sibling key field; until it is
                    // picked the dropdown says so instead of guessing.
                    venue={resolveVenue(f.catalogue, fields ?? [], fieldValues)}
                    catalogue={f.catalogue}
                    placeholder={f.placeholder ?? f.name}
                    title={f.description}
                    className="rounded-md px-2 py-1.5 text-xs font-mono w-52"
                    style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                  />
                ) : (
                  <input
                    value={fieldValues[f.name] ?? ''}
                    onChange={(e) => setFieldValues((v) => ({ ...v, [f.name]: e.target.value }))}
                    placeholder={f.placeholder ?? f.description ?? (f.default !== undefined ? String(f.default) : f.name)}
                    title={f.description}
                    className="rounded-md px-2 py-1.5 text-xs font-mono w-52"
                    style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                  />
                )}
              </div>
            ))}
            <button
              onClick={watchStructured}
              disabled={busy}
              className="px-3 py-1.5 rounded-md text-xs"
              style={{ background: 'var(--accent)', color: '#fff', opacity: busy ? 0.5 : 1 }}
            >
              Watch
            </button>
          </>
        ) : (
          <>
            {!standalone && (
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="key to watch"
                className="flex-1 rounded-md px-3 py-1.5 text-xs font-mono"
                style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              />
            )}
            <button
              onClick={() => void post({ key: key.trim() })}
              disabled={busy || (!standalone && !key.trim())}
              className="px-3 py-1.5 rounded-md text-xs"
              style={{ background: 'var(--accent)', color: '#fff', opacity: busy || (!standalone && !key.trim()) ? 0.5 : 1 }}
            >
              {standalone ? 'Start' : 'Watch'}
            </button>
          </>
        )}
      </div>
      {error && <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</p>}
    </div>
  )
}

// ── History panel ─────────────────────────────────────────────────────────────


/**
 * Friendly rendering: scalar fields inline; arrays/objects become chips that
 * open a JSON modal (with copy); the whole record is one click to copy.
 */
function DataView({ data }: { data: unknown }) {
  const [modal, setModal] = useState<{ title: string; data: unknown } | null>(null)
  if (data === null || typeof data !== 'object') {
    return <span style={{ color: 'var(--foreground)' }}>{String(data)}</span>
  }
  const entries = Object.entries(data as Record<string, unknown>)
  const scalars = entries.filter(([, v]) => v === null || typeof v !== 'object')
  const complex = entries.filter(([, v]) => v !== null && typeof v === 'object')
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0 flex-1">
      {scalars.map(([k, v]) => (
        <span key={k} className="whitespace-nowrap">
          <span style={{ color: 'var(--muted)' }}>{k}=</span>
          <span style={{ color: 'var(--foreground)' }}>{String(v)}</span>
        </span>
      ))}
      {complex.map(([k, v]) => (
        <button
          key={k}
          onClick={() => setModal({ title: k, data: v })}
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ color: 'var(--accent)', border: '1px solid var(--border)', background: 'transparent' }}
        >
          {k} {Array.isArray(v) ? `[${v.length}]` : '{…}'}
        </button>
      ))}
      <CopyButton value={data} />
      {modal && <JsonModal title={modal.title} data={modal.data} onClose={() => setModal(null)} />}
    </div>
  )
}
