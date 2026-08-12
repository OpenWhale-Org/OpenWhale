'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { AccountSnapshotRecord, AccountView, StrategyInstanceView } from '@openwhaleorg/core'

interface Stats {
  runs: { runs: number; instructions: number; windowHours: number }
  events: { count: number; windowHours: number }
  pnl: { net: number; realized: number; funding: number }
}

function usd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value >= 100_000 ? 0 : 2 })
}

function Sparkline({ values, positive = true }: { values: number[]; positive?: boolean }) {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = Math.max(1, max - min)
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${38 - ((v - min) / span) * 32}`).join(' ')
  return (
    <svg className="aurora-sparkline" viewBox="0 0 100 42" preserveAspectRatio="none">
      <polyline points={points} fill="none" stroke={positive ? 'var(--accent)' : 'var(--danger)'} strokeWidth="2.2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function AuroraOverview({ instances, accounts, snapshots }: { instances: StrategyInstanceView[]; accounts: AccountView[]; snapshots: Record<string, AccountSnapshotRecord> }) {
  const [stats, setStats] = useState<Stats | null>(null)
  const [pointer, setPointer] = useState({ x: 68, y: 28 })

  useEffect(() => {
    void fetch('/api/stats').then(async res => res.ok ? setStats(await res.json() as Stats) : undefined).catch(() => undefined)
  }, [])

  const totalEquity = useMemo(() => Object.values(snapshots).reduce((sum, item) => sum + item.equity, 0), [snapshots])
  const running = instances.filter(instance => instance.active).length
  const equitySeries = [42, 45, 44, 49, 51, 50, 55, 57, 61, 59, 64, 68, 67, 72, 75, 74, 79, 83, 81, 86, 89, 88, 92, 95, 93, 98]
  const todayPnl = stats?.pnl.net ?? 0

  return (
    <div className="aurora-overview">
      <section className="aurora-overview-hero" onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect()
        setPointer({ x: ((event.clientX - rect.left) / rect.width) * 100, y: ((event.clientY - rect.top) / rect.height) * 100 })
      }} style={{ '--hero-x': `${pointer.x}%`, '--hero-y': `${pointer.y}%` } as React.CSSProperties}>
        <div className="aurora-overview-glow" />
        <div>
          <span className="aurora-page-kicker"><i /> WORKSPACE ONLINE</span>
          <h1>Good evening</h1>
          <p>Your agents are monitoring markets and waiting for the next opportunity.</p>
        </div>
        <Link href="/instances" className="aurora-new-strategy">New Strategy <span>＋</span></Link>
      </section>

      <div className="aurora-kpi-grid">
        <article className="aurora-kpi-card">
          <span>Total Equity</span><strong>{usd(totalEquity)}</strong><small className="is-positive">● {accounts.length} connected accounts</small><Sparkline values={equitySeries.slice(-10)} />
        </article>
        <article className="aurora-kpi-card">
          <span>Today PnL</span><strong className={todayPnl < 0 ? 'is-negative' : ''}>{usd(todayPnl)}</strong><small className={todayPnl < 0 ? 'is-negative' : 'is-positive'}>{todayPnl >= 0 ? '↗' : '↘'} realized {usd(stats?.pnl.realized ?? 0)}</small><Sparkline values={todayPnl < 0 ? [...equitySeries.slice(-10)].reverse() : equitySeries.slice(-10)} positive={todayPnl >= 0} />
        </article>
        <article className="aurora-kpi-card">
          <span>Running Strategies</span><strong>{running} <em>/ {instances.length}</em></strong><small>{instances.length ? Math.round((running / instances.length) * 100) : 0}% of configured strategies</small><div className="aurora-kpi-ring" style={{ '--ring-value': `${instances.length ? (running / instances.length) * 360 : 0}deg` } as React.CSSProperties} /></article>
        <article className="aurora-kpi-card">
          <span>24h Runs</span><strong>{stats?.runs.runs.toLocaleString() ?? '—'}</strong><small>{stats?.runs.instructions.toLocaleString() ?? 0} execution instructions</small><Sparkline values={[4, 7, 6, 9, 8, 13, 11, 16, 15, 19]} />
        </article>
      </div>

      <div className="aurora-overview-grid">
        <article className="aurora-dashboard-card aurora-performance-card">
          <div className="aurora-card-header"><div><h2>Portfolio Curve</h2><p>Combined account equity</p></div><div className="aurora-time-tabs"><button>1D</button><button className="active">1W</button><button>1M</button><button>3M</button><button>ALL</button></div></div>
          <div className="aurora-equity-chart">
            <div className="aurora-chart-grid" />
            <svg viewBox="0 0 800 260" preserveAspectRatio="none">
              <defs><linearGradient id="overview-fill" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#8267f5" stopOpacity=".38"/><stop offset="1" stopColor="#8267f5" stopOpacity="0"/></linearGradient></defs>
              <path d="M0 218 C50 198 68 203 110 178 S180 190 222 157 S295 150 333 130 S400 144 445 107 S512 126 550 89 S620 93 664 61 S735 76 800 32 L800 260 L0 260Z" fill="url(#overview-fill)" />
              <path d="M0 218 C50 198 68 203 110 178 S180 190 222 157 S295 150 333 130 S400 144 445 107 S512 126 550 89 S620 93 664 61 S735 76 800 32" fill="none" stroke="#9075ff" strokeWidth="3" vectorEffect="non-scaling-stroke" />
            </svg>
            <div className="aurora-chart-axis"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Now</span></div>
          </div>
        </article>

        <article className="aurora-dashboard-card aurora-agents-card">
          <div className="aurora-card-header"><div><h2>Active Agents</h2><p>Currently operating</p></div><Link href="/instances">View all</Link></div>
          <div className="aurora-agent-list">
            {instances.slice(0, 5).map((instance, index) => (
              <Link href={`/instances/${encodeURIComponent(instance.id)}`} key={instance.id} className="aurora-agent-row">
                <span className={`aurora-agent-mark mark-${index % 4}`}>{instance.name.slice(0, 2).toUpperCase()}</span>
                <span className="aurora-agent-name"><strong>{instance.name}</strong><small>{instance.strategyId}</small></span>
                <span className={instance.active ? 'aurora-status-running' : 'aurora-status-paused'}><i /> {instance.active ? 'Running' : 'Paused'}</span>
              </Link>
            ))}
            {instances.length === 0 && <div className="aurora-empty-row">No strategy agents configured yet.</div>}
          </div>
        </article>

        <article className="aurora-dashboard-card aurora-decisions-card">
          <div className="aurora-card-header"><div><h2>Recent Activity</h2><p>Live system flow</p></div><span className="aurora-live-label"><i /> LIVE</span></div>
          {[['Monitor emit received', `${stats?.events.count ?? 0} events in 24h`, 'now'], ['Strategy evaluation completed', `${stats?.runs.runs ?? 0} runs recorded`, '2m'], ['Portfolio snapshot sampled', `${accounts.length} accounts updated`, '5m']].map(([title, sub, time], i) => <div className="aurora-activity-row" key={title}><i className={`activity-${i}`} /><span><strong>{title}</strong><small>{sub}</small></span><time>{time}</time></div>)}
        </article>

        <article className="aurora-dashboard-card aurora-health-card">
          <div className="aurora-card-header"><div><h2>System Health</h2><p>Gateway and runtime</p></div></div>
          {['Market Data', 'Strategy Engine', 'Executors', 'Database'].map((label, i) => <div className="aurora-health-row" key={label}><span>{label}</span><strong><i /> Healthy</strong><small>{12 + i * 9} ms</small></div>)}
          <div className="aurora-health-summary">✓ All systems operational</div>
        </article>
      </div>

      <Link href="/assistant" className="aurora-assistant-bar"><span className="aurora-assistant-orb" /><span>Ask OpenWhale about your portfolio…</span><kbd>⌘ K</kbd><b>↑</b></Link>
    </div>
  )
}
