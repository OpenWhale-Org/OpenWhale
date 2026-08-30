'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { startTour, tourWasSeen } from '@/components/Tour'
import { useSortable, DragHandle } from '@/components/Sortable'
import type { AccountSnapshotRecord, AccountView, StrategyInstanceView } from '@openwhaleorg/core'
import { PortfolioEquityChart, PortfolioEquitySparkline, usePortfolioEquity } from './PortfolioEquityChart'
import { MonitorBoards } from '../monitor/MonitorBoards'
import { InstanceWidget } from './InstanceWidget'
import { WidgetPicker } from './WidgetPicker'
import {
  defaultLayout, newWidgetId, parseLayout, spanOf, titleOf,
  type OverviewLayout, type Span, type Widget,
} from './widgets'

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

/**
 * The Overview, arranged by whoever runs the engine.
 *
 * Everything below the hero is a widget: the four figures, the four cards that
 * were hard-coded here, and the two that take a target — a monitor's panel and
 * a strategy instance. The default arrangement is exactly the old page, so an
 * operator who never opens the editor sees what they saw yesterday; a
 * customisable dashboard whose first act is to rearrange itself has spent its
 * credibility before it is used.
 */
export function AuroraOverview({ instances, accounts, snapshots }: {
  instances: StrategyInstanceView[]
  accounts: AccountView[]
  snapshots: Record<string, AccountSnapshotRecord>
}) {
  useFirstRunRedirect(instances.length === 0 && accounts.length === 0)
  const [stats, setStats] = useState<Stats | null>(null)
  const [pointer, setPointer] = useState({ x: 68, y: 28 })
  const portfolioEquity = usePortfolioEquity()

  const [layout, setLayout] = useState<OverviewLayout | null>(null)
  const [editing, setEditing] = useState(false)
  const [picking, setPicking] = useState(false)

  useEffect(() => {
    void fetch('/api/stats').then(async res => res.ok ? setStats(await res.json() as Stats) : undefined).catch(() => undefined)
  }, [])

  // Fetched after mount rather than server-rendered: the arrangement is small,
  // and a page that renders its default first and settles into the saved one
  // is a flash the operator sees on every visit.
  useEffect(() => {
    void fetch('/api/overview/layout')
      .then(r => (r.ok ? r.json() : { layout: null }) as Promise<{ layout: unknown }>)
      .then(({ layout: raw }) => setLayout(raw === null ? defaultLayout() : parseLayout(raw)))
      .catch(() => setLayout(defaultLayout()))
  }, [])

  const persist = useCallback((next: OverviewLayout) => {
    setLayout(next)
    void fetch('/api/overview/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layout: next }),
    }).catch(() => undefined)
  }, [])

  const widgets = layout?.widgets ?? []

  const move = (dragId: string, targetId: string) => {
    const ids = widgets.map(w => w.id)
    const from = ids.indexOf(dragId)
    const to = ids.indexOf(targetId)
    if (from < 0 || to < 0 || from === to) return
    const next = [...widgets]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    persist({ version: 1, widgets: next })
  }

  const { beginDrag, cardStyle } = useSortable({
    onReorder: () => {},
    onRefile: () => {},
    onFolderMove: move,
  })

  const remove = (id: string) => persist({ version: 1, widgets: widgets.filter(w => w.id !== id) })
  const resize = (id: string, span: Span) =>
    persist({ version: 1, widgets: widgets.map(w => (w.id === id ? { ...w, span } : w)) })

  async function resetLayout() {
    await fetch('/api/overview/layout', { method: 'DELETE' }).catch(() => undefined)
    setLayout(defaultLayout())
  }

  const totalEquity = useMemo(() => Object.values(snapshots).reduce((sum, item) => sum + item.equity, 0), [snapshots])
  const running = instances.filter(instance => instance.active).length
  const todayPnl = stats?.pnl.net ?? 0
  const portfolioPoints = portfolioEquity.data?.points ?? []
  const latestPortfolioPoint = [...portfolioPoints].reverse().find(point => point.accountCount === point.expectedAccountCount)
  const latestPortfolioSample = portfolioPoints[portfolioPoints.length - 1]
  const displayedTotalEquity = latestPortfolioPoint?.equity ?? totalEquity
  const displayedAccountCount = latestPortfolioSample?.accountCount ?? accounts.length

  const instanceNames = useMemo(
    () => Object.fromEntries(instances.map(i => [i.id, i.name])),
    [instances],
  )

  /** The widget's own content. The frame around it is the caller's. */
  function body(w: Widget) {
    switch (w.kind) {
      case 'equity':
        return (
          <article className="aurora-kpi-card">
            <span>Total Equity</span><strong>{usd(displayedTotalEquity)}</strong>
            <small className="is-positive">● {displayedAccountCount} connected accounts</small>
            <PortfolioEquitySparkline points={portfolioPoints} />
          </article>
        )
      case 'pnl-today':
        return (
          <article className="aurora-kpi-card">
            <span>Today PnL</span>
            <strong className={todayPnl < 0 ? 'is-negative' : ''}>{usd(todayPnl)}</strong>
            <small className={todayPnl < 0 ? 'is-negative' : 'is-positive'}>
              {todayPnl >= 0 ? '↗' : '↘'} realized {usd(stats?.pnl.realized ?? 0)}
            </small>
          </article>
        )
      case 'running':
        return (
          <article className="aurora-kpi-card">
            <span>Running Strategies</span><strong>{running} <em>/ {instances.length}</em></strong>
            <small>{instances.length ? Math.round((running / instances.length) * 100) : 0}% of configured strategies</small>
            <div className="aurora-kpi-ring" style={{ '--ring-value': `${instances.length ? (running / instances.length) * 360 : 0}deg` } as React.CSSProperties} />
          </article>
        )
      case 'runs-24h':
        return (
          <article className="aurora-kpi-card">
            <span>24h Runs</span><strong>{stats?.runs.runs.toLocaleString() ?? '—'}</strong>
            <small>{stats?.runs.instructions.toLocaleString() ?? 0} execution instructions</small>
          </article>
        )
      case 'portfolio-chart':
        return <PortfolioEquityChart state={portfolioEquity} />
      case 'agents':
        return (
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
        )
      case 'activity':
        return (
          <article className="aurora-dashboard-card aurora-decisions-card">
            <div className="aurora-card-header"><div><h2>Recent Activity</h2><p>Live system flow</p></div><span className="aurora-live-label"><i /> LIVE</span></div>
            {[['Monitor emit received', `${stats?.events.count ?? 0} events in 24h`, 'now'], ['Strategy evaluation completed', `${stats?.runs.runs ?? 0} runs recorded`, '2m'], ['Portfolio snapshot sampled', `${accounts.length} accounts updated`, '5m']]
              .map(([title, sub, time], i) => <div className="aurora-activity-row" key={title}><i className={`activity-${i}`} /><span><strong>{title}</strong><small>{sub}</small></span><time>{time}</time></div>)}
          </article>
        )
      case 'health':
        return (
          <article className="aurora-dashboard-card aurora-health-card">
            <div className="aurora-card-header"><div><h2>System Health</h2><p>Gateway and runtime</p></div></div>
            {['Market Data', 'Strategy Engine', 'Executors', 'Database'].map((label, i) => <div className="aurora-health-row" key={label}><span>{label}</span><strong><i /> Healthy</strong><small>{12 + i * 9} ms</small></div>)}
            <div className="aurora-health-summary">✓ All systems operational</div>
          </article>
        )
      case 'monitor-panel':
        return (
          <article className="aurora-dashboard-card">
            <div className="aurora-card-header">
              <div><h2>{titleOf(w)}</h2><p className="mono">{w.dataKey ?? 'no key'}</p></div>
              <Link href={`/monitor?id=${encodeURIComponent(w.monitorId)}`}>Open</Link>
            </div>
            <MonitorBoards
              monitorId={w.monitorId}
              keys={w.dataKey ? [w.dataKey] : []}
              emitCount={0}
              only={[w.panelId]}
              {...(w.dataKey ? { initialKey: w.dataKey } : {})}
              bare
            />
          </article>
        )
      case 'instance':
        return (
          <article className="aurora-dashboard-card">
            <div className="aurora-card-header">
              <div><h2>{titleOf(w, { instances: instanceNames })}</h2><p>Strategy</p></div>
            </div>
            <InstanceWidget instanceId={w.instanceId} />
          </article>
        )
    }
  }

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

      <div className="flex items-center gap-2 mb-3">
        {editing && (
          <>
            <button onClick={() => setPicking(true)} className="btn btn-primary btn-sm">＋ Add widget</button>
            <button onClick={() => void resetLayout()} className="btn btn-secondary btn-sm" title="Back to the built-in arrangement">
              Reset
            </button>
            <span className="text-xs" style={{ color: 'var(--muted)' }}>drag a grip to reorder · every change saves</span>
          </>
        )}
        <button
          onClick={() => setEditing(v => !v)}
          className={`btn btn-sm ml-auto ${editing ? 'btn-primary' : 'btn-secondary'}`}
        >
          {editing ? 'Done' : 'Edit layout'}
        </button>
      </div>

      {layout === null ? (
        <div className="text-sm py-10 text-center" style={{ color: 'var(--muted)' }}>Loading…</div>
      ) : widgets.length === 0 ? (
        <div className="text-sm py-10 text-center rounded-lg" style={{ color: 'var(--muted)', border: '1px dashed var(--border)' }}>
          Nothing on the page. <button onClick={() => { setEditing(true); setPicking(true) }} style={{ color: 'var(--accent)' }}>Add a widget</button>
          {' or '}<button onClick={() => void resetLayout()} style={{ color: 'var(--accent)' }}>restore the default</button>.
        </div>
      ) : (
        /* One four-column grid for everything, so a figure and a chart can sit
           on the same row. Widgets declare a span rather than a pixel width —
           the page has to survive a narrower window, and a card that knows how
           many columns it wants can be collapsed to one by the media query
           without knowing anything about the viewport. */
        <div className="aurora-widget-grid" data-cards="">
          {widgets.map((w) => (
            <div
              key={w.id}
              data-card-id={w.id}
              data-folder-id={w.id}
              data-span={spanOf(w)}
              style={cardStyle(w.id)}
              className="min-w-0"
            >
              {editing && (
                <div
                  className="flex items-center gap-1 mb-1 px-1 py-0.5 rounded-md"
                  style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
                >
                  <DragHandle onPointerDown={(e) => beginDrag('folder', w.id, e)} title="Drag to reorder" />
                  <span className="text-xs truncate" style={{ color: 'var(--muted)' }}>
                    {titleOf(w, { instances: instanceNames })}
                  </span>
                  <span className="ml-auto flex items-center gap-0.5">
                    {([1, 2, 3, 4] as Span[]).map(n => (
                      <button
                        key={n}
                        onClick={() => resize(w.id, n)}
                        title={`${n} of 4 columns`}
                        className="text-xs w-5 h-5 rounded"
                        style={{
                          border: `1px solid ${spanOf(w) === n ? 'var(--accent)' : 'var(--border)'}`,
                          color: spanOf(w) === n ? 'var(--accent)' : 'var(--muted)',
                        }}
                      >{n}</button>
                    ))}
                    <button
                      onClick={() => remove(w.id)}
                      title="Remove from the page"
                      className="text-xs w-5 h-5 rounded ml-1"
                      style={{ border: '1px solid var(--border)', color: 'var(--danger)' }}
                    >✕</button>
                  </span>
                </div>
              )}
              {body(w)}
            </div>
          ))}
        </div>
      )}

      {picking && (
        <WidgetPicker
          present={widgets.map(w => w.kind)}
          instances={instances}
          onAdd={(w) => persist({ version: 1, widgets: [...widgets, { ...w, id: w.id || newWidgetId() }] })}
          onClose={() => setPicking(false)}
        />
      )}

      <Link href="/assistant" className="aurora-assistant-bar"><span className="aurora-assistant-orb" /><span>Ask OpenWhale about your portfolio…</span><kbd>⌘ K</kbd><b>↑</b></Link>
    </div>
  )
}

