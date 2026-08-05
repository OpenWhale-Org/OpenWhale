'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * The four numbers that answer "is anything happening, and is it working" —
 * read at a glance, before the card list. Every figure states its window, so
 * a quiet day is never mistaken for a broken one.
 */

interface Stats {
  instances: { total: number; running: number }
  runs: { runs: number; instructions: number; windowHours: number }
  events: { count: number; windowHours: number; coveredMs: number }
  pnl: { net: number; realized: number; fees: number; funding: number; unrealized: number | null }
}

const compact = (n: number) =>
  n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : n.toLocaleString('en-US')

const money = (v: number) =>
  `${v > 0 ? '+' : ''}${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function pnlColor(v: number): string {
  if (v > 0.005) return 'var(--success)'
  if (v < -0.005) return 'var(--danger)'
  return 'var(--foreground)'
}

/** "24h" once the meter has watched that long, otherwise the honest coverage. */
function coverage(ms: number, windowHours: number): string {
  const hours = ms / 3_600_000
  if (hours >= windowHours - 0.05) return `${windowHours}h`
  if (hours >= 1) return `${hours.toFixed(1)}h uptime`
  return `${Math.max(1, Math.round(ms / 60_000))}m uptime`
}

function Stat({ label, value, sub, color, title }: {
  label: string
  value: string
  sub?: React.ReactNode
  color?: string
  title?: string
}) {
  return (
    <div className="card px-4 py-3 min-w-0" title={title}>
      <div className="text-xs" style={{ color: 'var(--muted)' }}>{label}</div>
      <div className="text-2xl font-semibold tabular mt-0.5 truncate" style={{ color: color ?? 'var(--foreground)' }}>
        {value}
      </div>
      <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--foreground-soft)' }}>{sub ?? ' '}</div>
    </div>
  )
}

export function StatsBar({ refreshKey }: { refreshKey?: number }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/stats')
      if (!res.ok) throw new Error(String(res.status))
      setStats(await res.json() as Stats)
      setFailed(false)
    } catch {
      // Keep the last good numbers on screen; a blip should not blank the bar.
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 30_000)
    return () => clearInterval(timer)
  }, [load, refreshKey])

  // Reserve the row's height from the first paint so the list below never jumps.
  if (!stats) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        {['Instances', 'Runs', 'Events', 'PnL'].map(l => (
          <Stat key={l} label={l} value="—" sub={failed ? 'unavailable' : 'loading…'} />
        ))}
      </div>
    )
  }

  const { instances, runs, events, pnl } = stats
  const idle = instances.running === 0 && instances.total > 0

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
      <Stat
        label="Instances"
        value={String(instances.total)}
        color={idle ? 'var(--foreground)' : undefined}
        sub={
          <span style={{ color: instances.running > 0 ? 'var(--success)' : 'var(--muted)' }}>
            {instances.running > 0 ? `● ${instances.running} running` : 'none running'}
          </span>
        }
      />
      <Stat
        label={`Runs · ${runs.windowHours}h`}
        value={compact(runs.runs)}
        sub={`${compact(runs.instructions)} instruction${runs.instructions === 1 ? '' : 's'}`}
        title="Strategy evaluations recorded in the last 24 hours, and how many of them emitted an execution instruction"
      />
      <Stat
        label={`Events · ${coverage(events.coveredMs, events.windowHours)}`}
        value={compact(events.count)}
        sub="monitor emits"
        title="Monitor emits counted since the gateway started — the live data flowing into your strategies"
      />
      <Stat
        label="PnL"
        value={money(pnl.net)}
        color={pnlColor(pnl.net)}
        sub={`realized ${money(pnl.realized)} · funding ${money(pnl.funding)}`}
        title={`Attributed across all instances — realized ${money(pnl.realized)}, fees ${money(pnl.fees)}, funding ${money(pnl.funding)}${pnl.unrealized !== null ? `, unrealized ${money(pnl.unrealized)}` : ''}`}
      />
    </div>
  )
}
