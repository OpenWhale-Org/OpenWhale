'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ExecutionResult } from '@openwhaleorg/core'
import { MonitorBoards } from '@/app/monitor/MonitorBoards'
import type { ChartRegion } from '@/components/SeriesChart'
import { subscribeLiveEvents } from '@/lib/live-events'
import { useT } from '@/i18n'

/**
 * The instance's monitors, as boards — one tab per (monitor, key) the running
 * instance is wired to, drawn by the same component the Monitor page uses,
 * with what the strategy DID laid over the data: a run that emitted
 * instructions and each execution as a reference line at its instant, so a
 * clip sits on the deviation that caused it. Stopped instances have no
 * sources (keys resolve at activation) and say so.
 */

interface Source { monitorName: string; key: string }
interface RunRow { startedAt: number; triggerId: string; instructions: number; error?: string }

export function InstanceMonitorsPanel({ instanceId, active }: { instanceId: string; active: boolean }) {
  const t = useT()
  const [sources, setSources] = useState<Source[] | null>(null)
  const [tab, setTab] = useState(0)
  const [runs, setRuns] = useState<RunRow[]>([])
  const [executions, setExecutions] = useState<ExecutionResult[]>([])
  const [emits, setEmits] = useState<Record<string, number>>({})
  const [open, setOpen] = useState(true)

  useEffect(() => {
    let gone = false
    const pull = async () => {
      const r = await fetch(`/api/instances/${encodeURIComponent(instanceId)}/sources`).catch(() => null)
      if (!r?.ok || gone) return
      setSources((await r.json()) as Source[])
    }
    void pull()
    const timer = setInterval(() => void pull(), 30_000)
    return () => { gone = true; clearInterval(timer) }
  }, [instanceId, active])

  // What the strategy did: runs with instructions, and every execution.
  useEffect(() => {
    let gone = false
    const pull = async () => {
      const [rr, re] = await Promise.all([
        fetch(`/api/instances/${encodeURIComponent(instanceId)}/runs`).catch(() => null),
        fetch(`/api/executions?instanceId=${encodeURIComponent(instanceId)}&limit=200`).catch(() => null),
      ])
      if (gone) return
      if (rr?.ok) setRuns(((await rr.json()) as RunRow[]).filter(r => r.instructions > 0 || r.error))
      if (re?.ok) setExecutions((await re.json()) as ExecutionResult[])
    }
    void pull()
    const timer = setInterval(() => void pull(), 15_000)
    return () => { gone = true; clearInterval(timer) }
  }, [instanceId])

  // Live emits bump the board's refresh, per monitor.
  useEffect(() => subscribeLiveEvents((data) => {
    const ev = data as { type?: string; monitor?: string; monitorName?: string }
    if (ev.type !== 'monitor') return
    const name = ev.monitor ?? ev.monitorName
    if (!name) return
    setEmits(prev => ({ ...prev, [name]: (prev[name] ?? 0) + 1 }))
  }), [])

  const markers = useMemo<ChartRegion[]>(() => {
    const out: ChartRegion[] = []
    for (const r of runs) {
      out.push({ from: r.startedAt, to: r.startedAt, tone: r.error ? 'warn' : 'neutral', label: r.error ? `run failed: ${r.error}` : `run: ${r.instructions} instruction${r.instructions === 1 ? '' : 's'}` })
    }
    for (const e of executions) {
      const at = new Date(e.executedAt as unknown as string).getTime()
      if (!Number.isFinite(at)) continue
      const action = (e.instruction as { action?: string } | undefined)?.action ?? 'execution'
      out.push({ from: at, to: at, tone: e.status === 'success' ? 'good' : 'warn', label: `${action} · ${e.status}${e.error ? ` · ${e.error}` : ''}` })
    }
    return out
  }, [runs, executions])

  const current = sources?.[Math.min(tab, Math.max(0, (sources?.length ?? 1) - 1))]

  return (
    <div className="rounded-lg mb-4 overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="w-full flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
        <button className="flex items-center gap-2 text-left py-0.5" onClick={() => setOpen(v => !v)}>
          <span>{open ? '▾' : '▸'}</span>
          <span>{t('board.monitors')}</span>
          <span className="text-xs font-normal" style={{ color: 'var(--muted)' }}>
            {sources === null ? '' : sources.length === 0 ? (active ? t('board.monitors.none') : t('board.monitors.stopped')) : t('board.monitors.marks')}
          </span>
        </button>
        {open && sources && sources.length > 1 && (
          /* A segmented pager, as the Executors page switches its views: one
             segment per source, wrapping onto a second row when they do not
             fit rather than scrolling behind a bar. */
          <div className="flex flex-wrap ml-auto rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
            {sources.map((s, i) => (
              <button
                key={`${s.monitorName}:${s.key}`}
                type="button"
                onClick={() => setTab(i)}
                aria-pressed={i === tab}
                className="text-xs px-2.5 h-7 font-mono whitespace-nowrap"
                title={`${s.monitorName} · ${s.key}`}
                style={{ background: i === tab ? 'var(--accent)' : 'transparent', color: i === tab ? '#fff' : 'var(--muted)' }}
              >
                {s.monitorName.split('/').pop()}{s.key && s.key !== '*' ? ` · ${shortKey(s.key)}` : ''}
              </button>
            ))}
          </div>
        )}
      </div>
      {open && current && (
        <div className="px-4 pb-4">
          <div className="text-xs font-mono mb-2 truncate" style={{ color: 'var(--muted)' }} title={`${current.monitorName} · ${current.key}`}>
            {current.monitorName}{current.key ? ` · ${current.key}` : ''}
          </div>
          <MonitorBoards
            key={`${current.monitorName}:${current.key}`}
            monitorId={current.monitorName}
            keys={current.key && current.key !== '*' ? [current.key] : []}
            initialKey={current.key}
            emitCount={emits[current.monitorName] ?? 0}
            extraRegions={markers}
            bare
            height={210}
          />
        </div>
      )}
    </div>
  )
}

/** The tail of a long key: the symbols, not the venues that prefix them. */
function shortKey(key: string): string {
  return key.length <= 22 ? key : `…${key.slice(-20)}`
}
