'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { startTour, tourWasSeen } from '@/components/Tour'
import { useSortable } from '@/components/Sortable'
import { useT } from '@/i18n'
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
  const t = useT()
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
            <span>{t('overview.totalEquity')}</span><strong>{usd(displayedTotalEquity)}</strong>
            <small className="is-positive">● {t('overview.connectedAccounts', { n: displayedAccountCount })}</small>
            <PortfolioEquitySparkline points={portfolioPoints} />
          </article>
        )
      case 'pnl-today':
        return (
          <article className="aurora-kpi-card">
            <span>{t('overview.todayPnl')}</span>
            <strong className={todayPnl < 0 ? 'is-negative' : ''}>{usd(todayPnl)}</strong>
            <small className={todayPnl < 0 ? 'is-negative' : 'is-positive'}>
              {todayPnl >= 0 ? '↗' : '↘'} {t('overview.realized', { v: usd(stats?.pnl.realized ?? 0) })}
            </small>
          </article>
        )
      case 'running':
        return (
          <article className="aurora-kpi-card">
            <span>{t('overview.runningStrategies')}</span><strong>{running} <em>/ {instances.length}</em></strong>
            <small>{t('overview.pctConfigured', { pct: instances.length ? Math.round((running / instances.length) * 100) : 0 })}</small>
            <div className="aurora-kpi-ring" style={{ '--ring-value': `${instances.length ? (running / instances.length) * 360 : 0}deg` } as React.CSSProperties} />
          </article>
        )
      case 'runs-24h':
        return (
          <article className="aurora-kpi-card">
            <span>{t('overview.runs24h')}</span><strong>{stats?.runs.runs.toLocaleString() ?? '—'}</strong>
            <small>{t('overview.instructions', { n: stats?.runs.instructions.toLocaleString() ?? 0 })}</small>
          </article>
        )
      case 'portfolio-chart':
        return <PortfolioEquityChart state={portfolioEquity} />
      case 'agents':
        return (
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
        )
      case 'activity':
        return (
          <article className="aurora-dashboard-card aurora-decisions-card">
            <div className="aurora-card-header"><div><h2>{t('overview.recentActivity')}</h2><p>{t('overview.liveFlow')}</p></div><span className="aurora-live-label"><i /> {t('overview.live')}</span></div>
            {[
              [t('overview.activity.emit'), t('overview.activity.emitSub', { n: stats?.events.count ?? 0 }), t('overview.time.now')],
              [t('overview.activity.eval'), t('overview.activity.evalSub', { n: stats?.runs.runs ?? 0 }), t('overview.time.minutes', { n: 2 })],
              [t('overview.activity.snapshot'), t('overview.activity.snapshotSub', { n: accounts.length }), t('overview.time.minutes', { n: 5 })],
            ]
              .map(([title, sub, time], i) => <div className="aurora-activity-row" key={title}><i className={`activity-${i}`} /><span><strong>{title}</strong><small>{sub}</small></span><time>{time}</time></div>)}
          </article>
        )
      case 'health':
        return (
          <article className="aurora-dashboard-card aurora-health-card">
            <div className="aurora-card-header"><div><h2>{t('overview.systemHealth')}</h2><p>{t('overview.gatewayRuntime')}</p></div></div>
            {[t('overview.health.marketData'), t('overview.health.engine'), t('overview.health.executors'), t('overview.health.database')].map((label, i) => <div className="aurora-health-row" key={label}><span>{label}</span><strong><i /> {t('overview.healthy')}</strong><small>{12 + i * 9} ms</small></div>)}
            <div className="aurora-health-summary">{t('overview.allOperational')}</div>
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
          <span className="aurora-page-kicker"><i /> {t('overview.kicker')}</span>
          <h1>{t('overview.greeting')}</h1>
          <p>{t('overview.tagline')}</p>
        </div>
        <Link href="/instances" className="aurora-new-strategy">{t('overview.newStrategy')} <span>＋</span></Link>
      </section>


      {layout === null ? (
        <div className="text-sm py-10 text-center" style={{ color: 'var(--muted)' }}>{t('overview.loading')}</div>
      ) : widgets.length === 0 ? (
        <div className="text-sm py-10 text-center rounded-lg" style={{ color: 'var(--muted)', border: '1px dashed var(--border)' }}>
          {t('overview.empty.nothing')} <button onClick={() => { setEditing(true); setPicking(true) }} style={{ color: 'var(--accent)' }}>{t('overview.empty.add')}</button>
          {t('overview.empty.or')}<button onClick={() => void resetLayout()} style={{ color: 'var(--accent)' }}>{t('overview.empty.restore')}</button>.
        </div>
      ) : (
        /* One four-column grid for everything, so a figure and a chart can sit
           on the same row. Widgets declare a span rather than a pixel width —
           the page has to survive a narrower window, and a card that knows how
           many columns it wants can be collapsed to one by the media query
           without knowing anything about the viewport. */
        <div className="aurora-widget-grid" data-cards="">
          {widgets.map((w, i) => (
            <div
              key={w.id}
              data-card-id={w.id}
              data-folder-id={w.id}
              data-span={spanOf(w)}
              style={cardStyle(w.id)}
              className={`aurora-widget min-w-0${editing ? ' is-editing' : ''}`}
            >
              {/* The jiggle lives on an inner shell, never on the card: the
                  card's transform is how the sortable places it, and a rotate
                  keyframe on the same element would stomp that. Staggered
                  delays so the page shimmers rather than marches. */}
              <div className="aurora-widget-shell" style={{ animationDelay: `${(i % 5) * -0.07}s` }}>
                {body(w)}
                {editing && (
                  /* Phone home-screen rules: in edit mode the widget's own
                     content is inert and the whole face is the grip. The
                     badges sit on the face and swallow their pointer-down so
                     tapping ✕ or a size never starts a drag. */
                  <div
                    className="aurora-widget-face"
                    onPointerDown={(e) => beginDrag('folder', w.id, e)}
                    title={t('overview.edit.hint')}
                  >
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => remove(w.id)}
                      className="aurora-widget-remove"
                      title={t('overview.edit.remove')}
                      aria-label={t('overview.edit.remove')}
                    >✕</button>
                    <div className="aurora-widget-size" onPointerDown={(e) => e.stopPropagation()}>
                      {([1, 2, 3, 4] as Span[]).map(n => (
                        <button
                          key={n}
                          onClick={() => resize(w.id, n)}
                          className={spanOf(w) === n ? 'is-active' : ''}
                          title={t('overview.edit.width', { n })}
                          aria-label={t('overview.edit.width', { n })}
                        >
                          {/* Four cells, the first n filled — the width as a
                              picture of itself, because "3" meant nothing. */}
                          {[1, 2, 3, 4].map(c => <i key={c} className={c <= n ? 'on' : ''} />)}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
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

      {/* Bottom-right, fixed, and quiet until it matters. At rest it is one
          low-contrast pencil; in edit mode it grows into the three actions the
          old toolbar held, anchored where the eye already is. */}
      <div className={`aurora-layout-fab${editing ? ' is-editing' : ''}`}>
        {editing && (
          <>
            <button onClick={() => setPicking(true)} className="aurora-fab-btn" title={t('overview.edit.add')} aria-label={t('overview.edit.add')}>＋</button>
            <button onClick={() => void resetLayout()} className="aurora-fab-btn" title={t('overview.edit.resetTitle')} aria-label={t('overview.edit.reset')}>↺</button>
          </>
        )}
        <button
          onClick={() => setEditing(v => !v)}
          className={`aurora-fab-btn${editing ? ' is-primary' : ''}`}
          title={editing ? t('overview.edit.done') : t('overview.edit.open')}
          aria-label={editing ? t('overview.edit.done') : t('overview.edit.open')}
        >
          {editing ? '✓' : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="5" rx="1.5" />
              <rect x="13" y="11" width="8" height="10" rx="1.5" /><rect x="3" y="14" width="8" height="7" rx="1.5" />
            </svg>
          )}
        </button>
      </div>

      <Link href="/assistant" className="aurora-assistant-bar"><span className="aurora-assistant-orb" /><span>{t('overview.askAssistant')}</span><kbd>⌘ K</kbd><b>↑</b></Link>
    </div>
  )
}

