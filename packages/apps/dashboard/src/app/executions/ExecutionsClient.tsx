'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import type { StrategyInstanceView } from '@openwhaleorg/core'
import { Select } from '@/components/Select'
import { RunSteps, type RunTrace } from '@/components/RunTrace'
import { subscribeLiveEvents } from '@/lib/live-events'

/**
 * Every instance's executions, newest first, with the run behind each one.
 *
 * An execution on its own says an order was placed; it does not say why. The
 * instruction carries the id of the run that decided it, so opening a row can
 * show that run's whole trace — the same steps the instance board shows,
 * fetched for this run alone rather than reconstructed from timestamps.
 */

interface ExecutionRecord {
  executorId: string
  status: 'success' | 'failed' | 'skipped' | 'dry-run'
  executedAt: string
  error?: string
  data?: Record<string, unknown>
  instruction: {
    messageId?: string
    action?: string
    executorId?: string
    instanceId?: string
    runId?: string
    params?: Record<string, unknown>
    accountNames?: string[]
  }
}

const STATUS_COLOR: Record<string, string> = {
  success: 'var(--success)',
  failed: 'var(--danger)',
  skipped: 'var(--muted)',
  'dry-run': 'var(--warning)',
}

/** Live rows accumulate; this caps what the page holds between reloads. */
const MAX_ROWS = 500

export function ExecutionsClient({ instances }: { instances: StrategyInstanceView[] }) {
  const [rows, setRows] = useState<ExecutionRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const [instanceId, setInstanceId] = useState('')
  const [status, setStatus] = useState('')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const names = useMemo(() => new Map(instances.map(i => [i.id, i.name])), [instances])

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({ limit: '200' })
    if (instanceId) params.set('instanceId', instanceId)
    if (status) params.set('status', status)
    const res = await fetch(`/api/executions?${params}`)
    if (res.ok) setRows(await res.json() as ExecutionRecord[])
    setLoading(false)
  }, [instanceId, status])

  useEffect(() => { void load() }, [load])

  // New executions arrive on the shared SSE connection: the same record the
  // log gets, so a live row and a reloaded one are identical.
  useEffect(() => subscribeLiveEvents((event) => {
    const e = event as { type?: string; execution?: ExecutionRecord }
    if (e.type !== 'execution' || !e.execution) return
    const row = { ...e.execution, executorId: e.execution.executorId ?? e.execution.instruction?.executorId ?? '' }
    if (instanceId && row.instruction?.instanceId !== instanceId) return
    if (status && row.status !== status) return
    setRows(prev => [row, ...prev].slice(0, MAX_ROWS))
  }, setLive), [instanceId, status])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r =>
      [r.instruction?.action, r.executorId, r.instruction?.instanceId, names.get(r.instruction?.instanceId ?? ''), r.error, JSON.stringify(r.instruction?.params ?? {})]
        .some(v => v?.toLowerCase().includes(q)))
  }, [rows, query, names])

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <h1 className="text-2xl font-semibold">Executions</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            What every instance actually sent, newest first — and the run that decided it.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: live ? 'var(--success)' : 'var(--muted)' }} />
            {live ? 'live' : 'offline'}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center my-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by action, executor, instance, error…"
          className="rounded-md px-3 py-2 text-sm flex-1 min-w-64"
          style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        />
        <Select
          value={instanceId}
          onChange={setInstanceId}
          options={[{ value: '', label: 'All instances' }, ...instances.map(i => ({ value: i.id, label: i.name }))]}
          className="min-w-52"
        />
        <Select
          value={status}
          onChange={setStatus}
          options={[
            { value: '', label: 'Any status' },
            { value: 'success', label: 'success' },
            { value: 'failed', label: 'failed' },
            { value: 'skipped', label: 'skipped' },
            { value: 'dry-run', label: 'dry-run' },
          ]}
          className="min-w-36"
        />
      </div>

      <div className="rounded-lg overflow-clip" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="grid gap-2 px-3 py-2 text-xs" style={{ gridTemplateColumns: '9rem 1fr 12rem 8rem 6rem', color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
          <span>Time</span><span>Action</span><span>Instance</span><span>Executor</span><span>Status</span>
        </div>
        {shown.length === 0 ? (
          <div className="px-3 py-6 text-sm" style={{ color: 'var(--muted)' }}>
            {loading ? 'Loading…' : 'No executions recorded yet. A strategy writes one here every time an instruction reaches an executor.'}
          </div>
        ) : shown.map((row, i) => (
          <ExecutionRow
            key={`${row.instruction?.messageId ?? i}:${row.executedAt}`}
            row={row}
            instanceName={names.get(row.instruction?.instanceId ?? '')}
            open={open === rowKey(row, i)}
            onToggle={() => setOpen(o => (o === rowKey(row, i) ? null : rowKey(row, i)))}
          />
        ))}
      </div>
    </div>
  )
}

const rowKey = (row: ExecutionRecord, i: number): string => `${row.instruction?.messageId ?? i}:${row.executedAt}`

function ExecutionRow({ row, instanceName, open, onToggle }: {
  row: ExecutionRecord
  instanceName?: string
  open: boolean
  onToggle: () => void
}) {
  const color = STATUS_COLOR[row.status] ?? 'var(--muted)'
  const instanceId = row.instruction?.instanceId
  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <div
        className="grid gap-2 px-3 py-1.5 text-xs items-center cursor-pointer"
        style={{ gridTemplateColumns: '9rem 1fr 12rem 8rem 6rem' }}
        onClick={onToggle}
      >
        <span className="mono" style={{ color: 'var(--muted)' }}>
          {open ? '▾' : '▸'} {new Date(row.executedAt).toLocaleTimeString()}
        </span>
        <span className="truncate">
          <span className="mono">{row.instruction?.action ?? '—'}</span>
          {row.error && <span className="ml-2 truncate" style={{ color: 'var(--danger)' }}>{row.error.slice(0, 80)}</span>}
        </span>
        <span className="truncate" style={{ color: 'var(--muted)' }}>{instanceName ?? instanceId ?? '—'}</span>
        <span className="truncate mono" style={{ color: 'var(--muted)' }}>{row.executorId || row.instruction?.executorId}</span>
        <span className="px-1.5 py-0.5 rounded text-xs justify-self-start" style={{ background: color + '22', color }}>{row.status}</span>
      </div>
      {open && <ExecutionDetail row={row} instanceName={instanceName} />}
    </div>
  )
}

function ExecutionDetail({ row, instanceName }: { row: ExecutionRecord; instanceName?: string }) {
  const instanceId = row.instruction?.instanceId
  const runId = row.instruction?.runId
  const [run, setRun] = useState<RunTrace | null>(null)
  const [runError, setRunError] = useState('')
  const asked = useRef<string>('')

  useEffect(() => {
    if (!instanceId || !runId) return
    const token = `${instanceId}:${runId}`
    if (asked.current === token) return
    asked.current = token
    let gone = false
    void (async () => {
      const res = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/runs/${encodeURIComponent(runId)}`)
      if (gone) return
      if (res.ok) setRun(await res.json() as RunTrace)
      // A no-op run older than the sampler's heartbeat is genuinely not on
      // disk; say that rather than showing an empty trace as if it were one.
      else setRunError('This run is no longer on disk — traces are kept for the recent days only.')
    })()
    return () => { gone = true }
  }, [instanceId, runId])

  return (
    <div className="px-3 pb-3 flex flex-col gap-3">
      <div className="grid gap-3 text-xs" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))' }}>
        <Field label="Instruction">
          <pre className="p-2 rounded overflow-x-auto max-h-64 overflow-y-auto scroll-hidden leading-snug"
               style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
            {JSON.stringify(row.instruction ?? {}, null, 2)}
          </pre>
        </Field>
        <Field label={row.status === 'failed' ? 'Error' : 'Result'}>
          <pre className="p-2 rounded overflow-x-auto max-h-64 overflow-y-auto scroll-hidden leading-snug"
               style={{ background: 'var(--background)', border: '1px solid var(--border)', color: row.error ? 'var(--danger)' : 'var(--foreground)' }}>
            {row.error ?? JSON.stringify(row.data ?? {}, null, 2)}
          </pre>
        </Field>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
          <span>Run</span>
          {run && <span className="mono">{run.triggerId} · {run.durationMs}ms · {run.instructions} instruction{run.instructions === 1 ? '' : 's'}</span>}
          {instanceId && (
            <Link href={`/instances/${instanceId}`} className="ml-auto" style={{ color: 'var(--accent)' }}>
              Open {instanceName ?? instanceId} →
            </Link>
          )}
        </div>
        {!runId ? (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            This instruction carries no run id — it was emitted before executions were linked to runs, or pushed outside a strategy run.
          </span>
        ) : runError ? (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>{runError}</span>
        ) : run ? (
          <RunSteps run={run} className="" />
        ) : (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Loading the run…</span>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      {children}
    </div>
  )
}
