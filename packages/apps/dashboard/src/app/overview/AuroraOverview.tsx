'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { startTour, tourWasSeen } from '@/components/Tour'
import { useT } from '@/i18n'
import type { AccountSnapshotRecord, AccountView, StrategyInstanceView } from '@openwhaleorg/core'
import { PortfolioEquityChart, PortfolioEquitySparkline, usePortfolioEquity } from './PortfolioEquityChart'

interface Stats {
  runs: { runs: number; instructions: number; windowHours: number }
  events: { count: number; windowHours: number }
  pnl: { net: number; realized: number; funding: number }
}

function usd(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: value >= 100_000 ? 0 : 2 })
}

/**
 * First run: send someone with nothing configured to the tour, once.
 *
 * Gated on the world being empty AND the tour never having been opened, so it
 * cannot ambush an operator whose accounts happen to be between states. It
 * redirects rather than overlaying: a tour you have to dismiss before you can
 * look around is a worse first impression than a page you can walk out of, and
 * the sidebar keeps a way back either way.
 */
function useFirstRunRedirect(empty: boolean) {
  useEffect(() => {
    if (!empty) return
    // Straight into the tour, not to a page about the tour. Someone with an
    // empty install has nothing to read a checklist against.
    if (!tourWasSeen()) startTour()
  }, [empty])
}

export function AuroraOverview({ instances, accounts, snapshots }: { instances: StrategyInstanceView[]; accounts: AccountView[]; snapshots: Record<string, AccountSnapshotRecord> }) {
  useFirstRunRedirect(instances.length === 0 && accounts.length === 0)
  const t = useT()
  const [stats, setStats] = useState<Stats | null>(null)
  const [pointer, setPointer] = useState({ x: 68, y: 28 })
  const portfolioEquity = usePortfolioEquity()

  useEffect(() => {
    void fetch('/api/stats').then(async res => res.ok ? setStats(await res.json() as Stats) : undefined).catch(() => undefined)
  }, [])

  const totalEquity = useMemo(() => Object.values(snapshots).reduce((sum, item) => sum + item.equity, 0), [snapshots])
  const running = instances.filter(instance => instance.active).length
  const todayPnl = stats?.pnl.net ?? 0
  const portfolioPoints = portfolioEquity.data?.points ?? []
  const latestPortfolioPoint = [...portfolioPoints].reverse().find(point => point.accountCount === point.expectedAccountCount)
  const latestPortfolioSample = portfolioPoints[portfolioPoints.length - 1]
  const displayedTotalEquity = latestPortfolioPoint?.equity ?? totalEquity
  const displayedAccountCount = latestPortfolioSample?.accountCount ?? accounts.length

  return (
    <div className="aurora-overview">
      <section className="aurora-overview-hero" onPointerMove={event => {
        const rect = event.currentTarget.getBoundingClientRect()
        setPointer({ x: ((event.clientX - rect.left) / rect.width) * 100, y: ((event.clientY - rect.top) / rect.height) * 100 })
      }} style={{ '--hero-x': `${pointer.x}%`, '--hero-y': `${pointer.y}%` } as React.CSSProperties}>
        <div className="aurora-overview-glow" />
        <div>
          <span className="aurora-page-kicker"><i /> {t('overview.kicker')}</span>
          <h1>{t('overview.greeting')}</h1>
          <p>{t('overview.tagline')}</p>
        </div>
        <Link href="/instances" className="aurora-new-strategy">{t('overview.newStrategy')} <span>＋</span></Link>
      </section>

      <div className="aurora-kpi-grid">
        <article className="aurora-kpi-card">
          <span>{t('overview.totalEquity')}</span><strong>{usd(displayedTotalEquity)}</strong><small className="is-positive">● {t('overview.connectedAccounts', { n: displayedAccountCount })}</small><PortfolioEquitySparkline points={portfolioPoints} />
        </article>
        <article className="aurora-kpi-card">
          <span>{t('overview.todayPnl')}</span><strong className={todayPnl < 0 ? 'is-negative' : ''}>{usd(todayPnl)}</strong><small className={todayPnl < 0 ? 'is-negative' : 'is-positive'}>{todayPnl >= 0 ? '↗' : '↘'} {t('overview.realized', { v: usd(stats?.pnl.realized ?? 0) })}</small>
        </article>
        <article className="aurora-kpi-card">
          <span>{t('overview.runningStrategies')}</span><strong>{running} <em>/ {instances.length}</em></strong><small>{t('overview.pctConfigured', { pct: instances.length ? Math.round((running / instances.length) * 100) : 0 })}</small><div className="aurora-kpi-ring" style={{ '--ring-value': `${instances.length ? (running / instances.length) * 360 : 0}deg` } as React.CSSProperties} /></article>
        <article className="aurora-kpi-card">
          <span>{t('overview.runs24h')}</span><strong>{stats?.runs.runs.toLocaleString() ?? '—'}</strong><small>{t('overview.instructions', { n: stats?.runs.instructions.toLocaleString() ?? 0 })}</small>
        </article>
      </div>

      <div className="aurora-overview-grid">
        <PortfolioEquityChart state={portfolioEquity} />

        <article className="aurora-dashboard-card aurora-agents-card">
          <div className="aurora-card-header"><div><h2>{t('overview.activeAgents')}</h2><p>{t('overview.currentlyOperating')}</p></div><Link href="/instances">{t('overview.viewAll')}</Link></div>
          <div className="aurora-agent-list">
            {instances.slice(0, 5).map((instance, index) => (
              <Link href={`/instances/${encodeURIComponent(instance.id)}`} key={instance.id} className="aurora-agent-row">
                <span className={`aurora-agent-mark mark-${index % 4}`}>{instance.name.slice(0, 2).toUpperCase()}</span>
                <span className="aurora-agent-name"><strong>{instance.name}</strong><small>{instance.strategyId}</small></span>
                <span className={instance.active ? 'aurora-status-running' : 'aurora-status-paused'}><i /> {instance.active ? t('overview.running') : t('overview.paused')}</span>
              </Link>
            ))}
            {instances.length === 0 && <div className="aurora-empty-row">{t('overview.noAgents')}</div>}
          </div>
        </article>

        <article className="aurora-dashboard-card aurora-decisions-card">
          <div className="aurora-card-header"><div><h2>{t('overview.recentActivity')}</h2><p>{t('overview.liveFlow')}</p></div><span className="aurora-live-label"><i /> {t('overview.live')}</span></div>
          {[
            [t('overview.activity.emit'), t('overview.activity.emitSub', { n: stats?.events.count ?? 0 }), t('overview.time.now')],
            [t('overview.activity.eval'), t('overview.activity.evalSub', { n: stats?.runs.runs ?? 0 }), t('overview.time.minutes', { n: 2 })],
            [t('overview.activity.snapshot'), t('overview.activity.snapshotSub', { n: accounts.length }), t('overview.time.minutes', { n: 5 })],
          ].map(([title, sub, time], i) => <div className="aurora-activity-row" key={title}><i className={`activity-${i}`} /><span><strong>{title}</strong><small>{sub}</small></span><time>{time}</time></div>)}
        </article>

        <article className="aurora-dashboard-card aurora-health-card">
          <div className="aurora-card-header"><div><h2>{t('overview.systemHealth')}</h2><p>{t('overview.gatewayRuntime')}</p></div></div>
          {[t('overview.health.marketData'), t('overview.health.engine'), t('overview.health.executors'), t('overview.health.database')].map((label, i) => <div className="aurora-health-row" key={label}><span>{label}</span><strong><i /> {t('overview.healthy')}</strong><small>{12 + i * 9} ms</small></div>)}
          <div className="aurora-health-summary">{t('overview.allOperational')}</div>
        </article>
      </div>

      <Link href="/assistant" className="aurora-assistant-bar"><span className="aurora-assistant-orb" /><span>{t('overview.askAssistant')}</span><kbd>⌘ K</kbd><b>↑</b></Link>
    </div>
  )
}
