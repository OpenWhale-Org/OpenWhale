'use client'

import { useEffect, useState, useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import type { MonitorDefinition, ParamFieldCatalogue, MonitorInstanceView, CredentialInfo } from '@openwhaleorg/core'
import { subscribeLiveEvents } from '@/lib/live-events'
import { MonitorBoards } from './MonitorBoards'
import { MonitorInstancesPanel, type ImplementationInfo } from './MonitorInstancesPanel'
import { LogsPanel } from '@/components/LogsPanel'
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
    <div className="flex gap-4 items-start">
      {/* ── Left: monitors grouped by package ── */}
      <aside className="w-72 shrink-0 flex flex-col gap-4">
        {statuses.length === 0 && monitors.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No monitors registered.</p>
        )}
        {[...groups.entries()].map(([pkg, items]) => (
          <div key={pkg} className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase px-1" style={{ color: 'var(--muted)' }}>{pkg}</span>
            {items.map((m) => {
              /* Two independent facts, deliberately shown as two marks:
                 RUNNING = an instance of this contract is activated (something
                 is capable of collecting); SUBSCRIBED = keys are actually being
                 watched. A monitor can run with nothing subscribed, and can
                 have subscriptions nothing is serving — that second case is the
                 silent failure this marker exists to expose. */
              const mine = instances.filter(i => i.contract === m.id)
              const running = mine.filter(i => i.active).length
              return (
              <button
                key={m.id}
                onClick={() => setSelectedId(m.id)}
                className="rounded-md px-3 py-2 text-left"
                style={{
                  background: m.id === selectedId ? 'var(--surface)' : 'transparent',
                  border: `1px solid ${m.id === selectedId ? 'var(--accent)' : 'var(--border)'}`,
                }}
              >
                <div className="flex items-center gap-2">
                  {mine.length > 0 && (
                    <span
                      className="text-xs shrink-0"
                      style={{ color: running > 0 ? 'var(--success, #22c55e)' : 'var(--muted)' }}
                      title={running > 0
                        ? `${running} of ${mine.length} instance${mine.length > 1 ? 's' : ''} running`
                        : `${mine.length} instance${mine.length > 1 ? 's' : ''}, none running`}
                    >
                      {running > 0 ? '◉' : '○'}{mine.length > 1 ? ` ${running}/${mine.length}` : ''}
                    </span>
                  )}
                  <span className="text-sm font-medium truncate">{splitId(m.id).short}</span>
                  {m.activeKeys.length > 0 && (
                    <span
                      className="text-xs px-1.5 rounded-full shrink-0"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                      title={`${m.activeKeys.length} key${m.activeKeys.length > 1 ? 's' : ''} subscribed`}
                    >
                      {m.activeKeys.length}
                    </span>
                  )}
                </div>
                {m.description && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {m.description}
                  </p>
                )}
              </button>
              )
            })}
          </div>
        ))}
      </aside>

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
  const [historyKey, setHistoryKey] = useState<string | null>(null)
  const [showLogs, setShowLogs] = useState(false)
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
        <div className="flex-1 min-w-0">
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
        <button
          onClick={() => setShowLogs(v => !v)}
          className="text-xs px-2 py-1 rounded"
          style={{ background: showLogs ? 'var(--accent)' : 'var(--surface)', color: showLogs ? '#fff' : 'var(--muted)', border: '1px solid var(--border)' }}
        >
          logs
        </button>
      </div>

      {showLogs && <LogsPanel id={status.id} logsUrl={`/api/monitor/${encodeURIComponent(status.id)}/logs?n=200`} sseType="monitor_log" />}

      {/* Instances — the runners behind this contract. Above ADD WATCH because
          watching a key does nothing until something is active to serve it. */}
      <MonitorInstancesPanel
        contract={status.id}
        instances={instances}
        implementations={implementations}
        pendingKeys={pendingKeys}
        credentials={credentials}
        onChanged={onChanged}
      />

      {/* Add a watch */}
      <section className="rounded-lg p-4 flex flex-col gap-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>ADD WATCH</span>
        <WatchForm status={status} onChanged={onChanged} />
      </section>

      {/* Boards — panels declared by the monitor's plots() convention */}
      <MonitorBoards
        monitorId={status.id}
        keys={Array.from(new Set([...status.activeKeys.map(k => k.key), ...status.manualKeys, ...status.dataKeys]))}
        emitCount={events.length}
      />

      {/* Running keys */}
      <section className="rounded-lg p-4 flex flex-col gap-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>RUNNING ({status.activeKeys.length})</span>
        {status.backfillingKeys && status.backfillingKeys.length > 0 && (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            Backfilling history for {status.backfillingKeys.join(', ')} — live collection starts when it lands.
          </p>
        )}
        {status.activeKeys.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>Nothing running — add a watch above or activate a strategy instance.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {status.activeKeys.map(({ key: k, refCount }) => {
              const manual = status.manualKeys.includes(k)
              // A blank key means a subscription's structured keyParams never got
              // composed into a key, so it is subscribed to nothing and collects
              // nothing — silently. Hiding these rows was how that bug survived a
              // day of live cycles; the blank chip is the only visible symptom, so
              // it is called out rather than filtered away.
              const unresolved = k.trim().length === 0
              return (
                <span
                  key={k}
                  className="text-xs px-2 py-1 rounded-md font-mono flex items-center gap-1.5"
                  title={unresolved ? 'Subscribed with an empty key — its keyParams were never resolved, so it receives nothing' : undefined}
                  style={{
                    background: 'var(--background)',
                    border: `1px solid ${unresolved ? 'var(--danger)' : manual ? 'var(--accent)' : 'var(--border)'}`,
                    ...(unresolved ? { color: 'var(--danger)' } : {}),
                  }}
                >
                  {unresolved ? '⚠ unresolved key' : k} <span style={{ color: 'var(--muted)' }}>×{refCount}</span>
                  {manual && (
                    <button onClick={() => void unwatch(k)} disabled={busy} title="Stop manual watch" style={{ color: 'var(--danger)' }}>✕</button>
                  )}
                </span>
              )
            })}
          </div>
        )}
        {error && <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</p>}
      </section>

      {/* History: every key that ever stored data */}
      <section className="rounded-lg p-4 flex flex-col gap-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>HISTORY</span>
        {status.dataKeys.length === 0 ? (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>No recorded data yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {status.dataKeys.map((k) => (
              <button
                key={k}
                onClick={() => setHistoryKey(historyKey === k ? null : k)}
                className="text-xs px-2 py-1 rounded-md font-mono"
                style={{
                  background: historyKey === k ? 'var(--accent)' : 'var(--background)',
                  color: historyKey === k ? '#fff' : 'var(--foreground)',
                  border: '1px solid var(--border)',
                }}
              >
                {k}
              </button>
            ))}
          </div>
        )}
        {historyKey && <HistoryPanel monitorId={status.id} dataKey={historyKey} />}
      </section>

      {/* Live feed for this monitor */}
      <section className="rounded-lg overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="px-4 py-2 flex items-center gap-2 text-xs" style={{ background: 'var(--background)', color: 'var(--muted)' }}>
          LIVE
          <span className="w-2 h-2 rounded-full" style={{ background: connected ? 'var(--success)' : 'var(--danger)' }} />
          {connected ? 'connected' : 'disconnected'}
        </div>
        <div className="max-h-80 overflow-y-auto font-mono text-xs">
          {events.length === 0 ? (
            <p className="p-4" style={{ color: 'var(--muted)' }}>Waiting for emits…</p>
          ) : events.map((event, i) => (
            <div key={`${event.ts}-${i}`} className="px-4 py-2 flex gap-3 items-start" style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <span className="shrink-0 opacity-60" style={{ color: 'var(--muted)' }}>{new Date(event.ts).toLocaleTimeString()}</span>
              <span className="shrink-0" style={{ color: 'var(--warning)' }}>{event.key}</span>
              <DataView data={event.data} />
            </div>
          ))}
        </div>
      </section>
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

function HistoryPanel({ monitorId, dataKey }: { monitorId: string; dataKey: string }) {
  const [records, setRecords] = useState<MonitorRecord[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(100)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (n: number) => {
    setLoading(true)
    const res = await fetch(`/api/monitor/${encodeURIComponent(monitorId)}/${encodeURIComponent(dataKey)}?n=${n}`)
    if (res.ok) {
      const body = await res.json() as { records: MonitorRecord[]; total: number }
      setRecords(body.records)
      setTotal(body.total)
    }
    setLoading(false)
  }, [monitorId, dataKey])

  useEffect(() => { void load(limit) }, [load, limit])

  return (
    <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      <div className="px-3 py-1.5 flex items-center gap-2 text-xs" style={{ background: 'var(--background)', color: 'var(--muted)' }}>
        <span className="font-mono">{dataKey}</span>
        <span className="flex-1">{records.length} of {total} records{loading ? ' · loading…' : ''}</span>
        {total > records.length && (
          <button onClick={() => setLimit((n) => Math.min(1000, n + 200))} style={{ color: 'var(--accent)' }}>load more</button>
        )}
        <button onClick={() => void load(limit)} style={{ color: 'var(--accent)' }}>refresh</button>
      </div>
      <div className="max-h-72 overflow-y-auto font-mono text-xs">
        {records.length === 0 ? (
          <p className="p-3" style={{ color: 'var(--muted)' }}>No records.</p>
        ) : [...records].reverse().map((r, i) => (
          <div key={`${r.ts}-${i}`} className="px-3 py-1.5 flex gap-3 items-start" style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
            <span className="shrink-0 opacity-60" style={{ color: 'var(--muted)' }}>{new Date(r.ts).toLocaleString()}</span>
            <DataView data={r.data} />
          </div>
        ))}
      </div>
    </div>
  )
}

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
