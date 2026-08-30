'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import type { ExecutionResult, StrategyInstanceView } from '@openwhaleorg/core'

/**
 * One strategy, at overview size.
 *
 * Three things, because they are the three questions asked of a running
 * strategy in that order: is it alive, is it making money, and what did it
 * just do. The instance page holds everything else, and the title links to it
 * rather than this widget growing toward it.
 */

interface Pnl { realized: number; fees: number; funding: number; net: number; unrealized: number }

const usd = (v: number): string =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 })

const ago = (ts: number): string => {
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86_400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86_400)}d`
}

export function InstanceWidget({ instanceId }: { instanceId: string }) {
  const [instance, setInstance] = useState<StrategyInstanceView | null>(null)
  const [pnl, setPnl] = useState<Pnl | null>(null)
  const [executions, setExecutions] = useState<ExecutionResult[]>([])
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [insts, p, ex] = await Promise.all([
        fetch('/api/instances').then(r => (r.ok ? r.json() : [])) as Promise<StrategyInstanceView[]>,
        fetch(`/api/instances/${encodeURIComponent(instanceId)}/pnl`).then(r => (r.ok ? r.json() : null)) as Promise<Pnl | null>,
        fetch(`/api/instances/${encodeURIComponent(instanceId)}/executions`).then(r => (r.ok ? r.json() : [])) as Promise<ExecutionResult[]>,
      ])
      if (!alive) return
      const found = insts.find(i => i.id === instanceId) ?? null
      setInstance(found)
      setMissing(!found)
      setPnl(p)
      // Newest first, and only a few: this is a glance, not the audit trail.
      setExecutions([...ex].sort((a, b) => +new Date(b.executedAt) - +new Date(a.executedAt)).slice(0, 5))
    }
    void load().catch(() => { if (alive) setMissing(true) })
    const timer = setInterval(() => { void load().catch(() => {}) }, 30_000)
    return () => { alive = false; clearInterval(timer) }
  }, [instanceId])

  /* A widget outliving its instance says so and offers nothing else. Rendering
     an empty card would leave the operator to work out for themselves why one
     of their strategies has gone quiet. */
  if (missing) {
    return (
      <div className="text-xs py-6 text-center" style={{ color: 'var(--muted)' }}>
        This instance no longer exists. Remove the widget in <span style={{ color: 'var(--foreground)' }}>Edit layout</span>.
      </div>
    )
  }
  if (!instance) return <div className="text-xs py-6 text-center" style={{ color: 'var(--muted)' }}>Loading…</div>

  const net = pnl?.net ?? 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span
          className="text-xs px-1.5 py-0.5 rounded shrink-0"
          style={{
            border: `1px solid ${instance.active ? 'var(--success)' : 'var(--border)'}`,
            color: instance.active ? 'var(--success)' : 'var(--muted)',
          }}
        >{instance.active ? 'Running' : 'Paused'}</span>
        <span className="text-xs mono truncate" style={{ color: 'var(--muted)' }}>{instance.strategyId}</span>
      </div>

      <div className="flex items-baseline gap-4 flex-wrap">
        <span>
          <span className="text-xs block" style={{ color: 'var(--muted)' }}>Net</span>
          <strong className="text-lg" style={{ color: net > 0 ? 'var(--success)' : net < 0 ? 'var(--danger)' : 'var(--foreground)' }}>
            {pnl ? usd(net) : '—'}
          </strong>
        </span>
        <span>
          <span className="text-xs block" style={{ color: 'var(--muted)' }}>Realized</span>
          <span className="text-sm mono">{pnl ? usd(pnl.realized) : '—'}</span>
        </span>
        <span>
          <span className="text-xs block" style={{ color: 'var(--muted)' }}>Funding</span>
          <span className="text-sm mono">{pnl ? usd(pnl.funding) : '—'}</span>
        </span>
      </div>

      <div className="flex flex-col gap-1">
        {executions.length === 0 ? (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>No executions recorded yet.</span>
        ) : executions.map((e, i) => {
          const failed = e.status === 'failed'
          return (
            <div key={`${e.instruction.messageId ?? i}`} className="flex items-center gap-2 text-xs">
              <span
                className="shrink-0"
                style={{ color: failed ? 'var(--danger)' : e.status === 'success' ? 'var(--success)' : 'var(--muted)' }}
                title={e.status}
              >●</span>
              <span className="mono truncate" style={{ color: 'var(--foreground)' }}>{e.instruction.action}</span>
              {/* The error, not just that there was one: "failed" sends the
                  reader to another page, the venue's words often do not. */}
              {failed && e.error && (
                <span className="truncate" style={{ color: 'var(--danger)' }} title={e.error}>{e.error}</span>
              )}
              <time className="ml-auto shrink-0" style={{ color: 'var(--muted)' }}>{ago(+new Date(e.executedAt))}</time>
            </div>
          )
        })}
      </div>

      <Link href={`/instances/${encodeURIComponent(instanceId)}`} className="text-xs" style={{ color: 'var(--accent)' }}>
        Open →
      </Link>
    </div>
  )
}
