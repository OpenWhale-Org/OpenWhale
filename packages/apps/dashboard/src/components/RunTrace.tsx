'use client'

import { useState } from 'react'

/**
 * One strategy run, rendered as what it actually is: a list of steps the
 * strategy recorded, plus the log lines that run caused.
 *
 * Lives here rather than on a page because two places ask the same question —
 * the instance board ("what has this instance been doing?") and the Executions
 * page ("why was this order placed?") — and they must answer it identically.
 */

export interface RunStepRecord {
  ts: number
  step: string
  data?: Record<string, unknown>
}

export interface RunTrace {
  /** Stable per instance; what an execution's `runId` points at. */
  runId?: string
  startedAt: number
  triggerId: string
  durationMs: number
  instructions: number
  error?: string
  steps: RunStepRecord[]
}

export function RunRow({ run, defaultOpen = false }: { run: RunTrace; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const color = run.error ? 'var(--danger)' : run.instructions > 0 ? 'var(--success)' : 'var(--muted)'
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex gap-2 items-start cursor-pointer" onClick={() => setOpen(o => !o)}>
        <span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'} {new Date(run.startedAt).toLocaleTimeString()}</span>
        <span className="px-1 rounded text-xs" style={{ background: color + '22', color }}>
          {run.error ? 'error' : `${run.instructions} instruction${run.instructions === 1 ? '' : 's'}`}
        </span>
        <span style={{ color: 'var(--muted)' }}>{run.durationMs}ms · {run.steps.length} steps · {run.triggerId}</span>
        {run.error && <span className="truncate" style={{ color: 'var(--danger)' }}>{run.error.slice(0, 60)}</span>}
      </div>
      {open && <RunSteps run={run} />}
    </div>
  )
}

/** The steps alone, for a view that has already said which run this is. */
export function RunSteps({ run, className = 'ml-4' }: { run: RunTrace; className?: string }) {
  return (
    <div className={`${className} flex flex-col gap-1 p-2 rounded`} style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
      {run.steps.length === 0
        ? <span className="text-xs" style={{ color: 'var(--muted)' }}>No steps recorded for this run.</span>
        : run.steps.map((s, i) => <RunStep key={i} step={s} startedAt={run.startedAt} />)}
    </div>
  )
}

export function RunStep({ step, startedAt }: { step: RunStepRecord; startedAt: number }) {
  const [open, setOpen] = useState(false)
  const hasData = step.data && Object.keys(step.data).length > 0
  const kind = step.step.split(':')[0]
  const kindColor = kind === 'leg' ? 'var(--accent)' : kind === 'instruction' ? 'var(--success)' : kind === 'gate' ? 'var(--warning)' : 'var(--muted)'
  return (
    <div className="flex flex-col gap-0.5">
      <div className={hasData ? 'flex gap-2 items-start cursor-pointer' : 'flex gap-2 items-start'}
           onClick={() => hasData && setOpen(o => !o)}>
        <span style={{ color: 'var(--muted)' }}>{hasData ? (open ? '▾' : '▸') : '·'} +{step.ts - startedAt}ms</span>
        <span style={{ color: kindColor }}>{step.step}</span>
        {!open && hasData && <span className="truncate" style={{ color: 'var(--muted)' }}>{JSON.stringify(step.data).slice(0, 90)}</span>}
      </div>
      {open && hasData && (
        <pre className="ml-6 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto scroll-hidden text-xs leading-snug"
             style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}>
          {JSON.stringify(step.data, null, 2)}
        </pre>
      )}
    </div>
  )
}
