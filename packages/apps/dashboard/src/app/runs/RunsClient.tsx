'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { StrategyInstanceView } from '@openwhaleorg/core'
import { Select } from '@/components/Select'
import { RunSteps, runClock, type RunTrace } from '@/components/RunTrace'
import { subscribeLiveEvents } from '@/lib/live-events'
import { useT } from '@/i18n'

/**
 * Every instance's runs, newest first, with the steps behind each one.
 *
 * The Executions page shows what was sent. This page shows what was decided
 * — including the runs that decided nothing, and the runs that failed before
 * they could decide. That last kind never becomes an execution: a strategy
 * whose position read came back 429 throws inside its own evaluation, the
 * run is recorded as an error, and no executor ever hears of it. Here it is a
 * red row with the venue's message on it, next to the runs around it.
 */

type Run = RunTrace & { instanceId: string }
type Status = '' | 'error' | 'instructions' | 'noop'

/** How often the list is refreshed while the page is visible. */
const POLL_MS = 5000
const PAGE = 200

export function RunsClient({ instances }: { instances: StrategyInstanceView[] }) {
  const t = useT()
  const [rows, setRows] = useState<Run[]>([])
  const [loading, setLoading] = useState(true)
  const [live, setLive] = useState(false)
  const [paused, setPaused] = useState(false)
  const [instanceId, setInstanceId] = useState('')
  const [status, setStatus] = useState<Status>('')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  const names = useMemo(() => new Map(instances.map(i => [i.id, i.name])), [instances])

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true)
    const params = new URLSearchParams({ limit: String(PAGE) })
    if (instanceId) params.set('instanceId', instanceId)
    if (status) params.set('status', status)
    const res = await fetch(`/api/runs?${params}`)
    if (res.ok) setRows(await res.json() as Run[])
    setLoading(false)
  }, [instanceId, status])

  useEffect(() => { void load() }, [load])

  // Runs are not pushed whole over SSE (a trace can be large, and most runs
  // are no-ops nobody is watching), so the list polls while it is on screen
  // and the operator has not paused it to read something.
  useEffect(() => {
    if (paused) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(true) }, POLL_MS)
    return () => clearInterval(timer)
  }, [load, paused])

  // The SSE connection is only the "live" light here — the poll does the work.
  useEffect(() => subscribeLiveEvents(() => undefined, setLive), [])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(r =>
      [r.triggerId, r.instanceId, names.get(r.instanceId), r.error, r.steps.map(s => s.step).join(' ')]
        .some(v => v?.toLowerCase().includes(q)))
  }, [rows, query, names])

  const errors = useMemo(() => rows.filter(r => r.error).length, [rows])

  return (
    <div>
      <div className="flex items-start justify-between gap-4 mb-1">
        <div>
          <h1 className="text-2xl font-semibold">{t('runs.title')}</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            {t('runs.intro')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
            <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: live && !paused ? 'var(--success)' : 'var(--muted)' }} />
            {paused ? t('ui.paused') : live ? t('ui.live') : t('ui.offline')}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPaused(p => !p)}>
            {paused ? t('ui.resume') : t('ui.pause')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={loading}>
            {loading ? t('common.loading') : t('common.refresh')}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center my-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('runs.filterPlaceholder')}
          className="rounded-md px-3 py-2 text-sm flex-1 min-w-64"
          style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        />
        <Select
          value={instanceId}
          onChange={setInstanceId}
          options={[{ value: '', label: t('ui.allInstances') }, ...instances.map(i => ({ value: i.id, label: i.name }))]}
          className="min-w-52"
        />
        <Select
          value={status}
          onChange={(v) => setStatus(v as Status)}
          options={[
            { value: '', label: t('runs.anyOutcome') },
            { value: 'error', label: t('runs.outcome.error') },
            { value: 'instructions', label: t('runs.outcome.instructions') },
            { value: 'noop', label: t('runs.outcome.noop') },
          ]}
          className="min-w-40"
        />
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {t('runs.shownOf', { shown: shown.length, total: rows.length })} · {errors === 1 ? t('ui.errorsOne') : t('ui.errorsN', { n: errors })}
        </span>
      </div>

      <div className="rounded-lg overflow-clip" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="grid gap-2 px-3 py-2 text-xs" style={{ gridTemplateColumns: '9rem 7rem 12rem 1fr 10rem', color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
          <span>{t('runs.col.time')}</span><span>{t('runs.col.outcome')}</span><span>{t('runs.col.instance')}</span><span>{t('runs.col.error')}</span><span>{t('runs.col.run')}</span>
        </div>
        {shown.length === 0 ? (
          <div className="px-3 py-6 text-sm" style={{ color: 'var(--muted)' }}>
            {loading ? t('common.loading') : t('runs.empty')}
          </div>
        ) : shown.map((run) => {
          const key = `${run.instanceId}:${run.runId ?? `${run.startedAt}:${run.triggerId}`}`
          return (
            <RunListRow
              key={key}
              run={run}
              instanceName={names.get(run.instanceId)}
              open={open === key}
              onToggle={() => { setOpen(o => (o === key ? null : key)); if (open !== key) setPaused(true) }}
            />
          )
        })}
      </div>
    </div>
  )
}

function RunListRow({ run, instanceName, open, onToggle }: {
  run: Run
  instanceName?: string
  open: boolean
  onToggle: () => void
}) {
  const t = useT()
  const color = run.error ? 'var(--danger)' : run.instructions > 0 ? 'var(--success)' : 'var(--muted)'
  const outcome = run.error ? t('ui.error')
    : run.instructions > 0 ? (run.instructions === 1 ? t('ui.instructionsOne') : t('ui.instructionsN', { n: run.instructions }))
    : t('ui.noop')
  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      <div
        className="grid gap-2 px-3 py-1.5 text-xs items-center cursor-pointer"
        style={{ gridTemplateColumns: '9rem 7rem 12rem 1fr 10rem' }}
        onClick={onToggle}
      >
        <span className="mono" style={{ color: 'var(--muted)' }}>
          {open ? '▾' : '▸'} {runClock(run.startedAt)}
        </span>
        <span className="px-1.5 py-0.5 rounded text-xs justify-self-start" style={{ background: color + '22', color }}>{outcome}</span>
        <span className="truncate" style={{ color: 'var(--muted)' }}>{instanceName ?? run.instanceId}</span>
        <span className="truncate" style={{ color: run.error ? 'var(--danger)' : 'var(--muted)' }}>{run.error ? run.error.slice(0, 120) : '—'}</span>
        <span className="truncate mono" style={{ color: 'var(--muted)' }}>{run.durationMs}ms · {run.steps.length === 1 ? t('ui.stepsOne') : t('ui.stepsN', { n: run.steps.length })}</span>
      </div>
      {open && (
        <div className="px-3 pb-3 flex flex-col gap-1.5">
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <span className="mono">{run.triggerId}</span>
            {run.runId && <span className="mono">· {run.runId}</span>}
            <Link href={`/instances/${run.instanceId}`} className="ml-auto" style={{ color: 'var(--accent)' }}>
              {t('ui.openInstance', { name: instanceName ?? run.instanceId })}
            </Link>
          </div>
          {run.error && (
            <pre className="p-2 rounded overflow-x-auto max-h-48 overflow-y-auto scroll-hidden leading-snug text-xs"
                 style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--danger)' }}>
              {run.error}
            </pre>
          )}
          <RunSteps run={run} className="" />
        </div>
      )}
    </div>
  )
}
