'use client'

import { useEffect, useState } from 'react'
import { subscribeLiveEvents } from '@/lib/live-events'

interface LogLine {
  ts: number
  level: string
  msg: string
  extra?: Record<string, unknown>
}

const LEVEL_COLORS: Record<string, string> = {
  error: 'var(--danger)', fatal: 'var(--danger)', warn: 'var(--warning)',
  info: 'var(--foreground)', debug: 'var(--muted)', trace: 'var(--muted)',
}

/**
 * Live log tail for one component: recent buffer via `logsUrl`, then lines
 * pushed over SSE (events of `sseType` whose `monitor` field equals `id`).
 */
export function LogsPanel({ id, logsUrl, sseType }: { id: string; logsUrl: string; sseType: string }) {
  const [lines, setLines] = useState<LogLine[]>([])

  useEffect(() => {
    let alive = true
    void fetch(logsUrl).then(async (res) => {
      if (res.ok && alive) setLines(await res.json() as LogLine[])
    })
    const unsubscribe = subscribeLiveEvents((data) => {
      const ev = data as { type?: string; monitor?: string } & LogLine
      if (ev.type !== sseType || ev.monitor !== id) return
      setLines((prev) => [...prev, { ts: ev.ts, level: ev.level, msg: ev.msg, extra: ev.extra }].slice(-300))
    })
    return () => { alive = false; unsubscribe() }
  }, [id, logsUrl, sseType])

  return (
    <div className="rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      <div className="px-3 py-1.5 text-xs" style={{ background: 'var(--background)', color: 'var(--muted)' }}>
        logs · live <span className="animate-pulse">●</span>
      </div>
      <div className="max-h-72 overflow-y-auto font-mono text-xs">
        {lines.length === 0 ? (
          <p className="p-3" style={{ color: 'var(--muted)' }}>No log lines yet.</p>
        ) : lines.map((line, i) => (
          <div key={`${line.ts}-${i}`} className="px-3 py-1 flex gap-2 items-start" style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
            <span className="shrink-0 opacity-60" style={{ color: 'var(--muted)' }}>{new Date(line.ts).toLocaleTimeString()}</span>
            <span className="shrink-0 uppercase" style={{ color: LEVEL_COLORS[line.level] ?? 'var(--muted)' }}>{line.level}</span>
            <span className="break-all" style={{ color: 'var(--foreground)' }}>
              {line.msg}
              {line.extra && Object.keys(line.extra).length > 0 && (
                <span style={{ color: 'var(--muted)' }}> {JSON.stringify(line.extra)}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
