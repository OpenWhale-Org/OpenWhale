/**
 * What the Overview is made of.
 *
 * Everything on the page below the hero is a widget, including the four
 * figures and the four cards that used to be hard-coded. Making only the new
 * ones removable would leave an operator able to add a monitor panel but not
 * to drop the card they never read, which is the half of customisation that
 * matters least.
 */

export type Widget =
  /** The built-ins, as they were. */
  | { id: string; kind: 'equity'; span?: Span }
  | { id: string; kind: 'pnl-today'; span?: Span }
  | { id: string; kind: 'running'; span?: Span }
  | { id: string; kind: 'runs-24h'; span?: Span }
  | { id: string; kind: 'portfolio-chart'; span?: Span }
  | { id: string; kind: 'agents'; span?: Span }
  | { id: string; kind: 'activity'; span?: Span }
  | { id: string; kind: 'health'; span?: Span }
  /** One chart from one monitor's board. */
  | { id: string; kind: 'monitor-panel'; monitorId: string; panelId: string; dataKey?: string; title?: string; span?: Span }
  /** One strategy instance: status, today's PnL, its last few executions. */
  | { id: string; kind: 'instance'; instanceId: string; span?: Span }

export type WidgetKind = Widget['kind']
/** Columns out of four. The grid is four wide at desktop and collapses below. */
export type Span = 1 | 2 | 3 | 4

export interface OverviewLayout {
  version: 1
  widgets: Widget[]
}

export const newWidgetId = (): string => Math.random().toString(36).slice(2, 9)

interface KindMeta {
  label: string
  description: string
  defaultSpan: Span
  /** Only one of these makes sense on a page. */
  singleton?: boolean
}

export const KINDS: Record<WidgetKind, KindMeta> = {
  'equity': { label: 'Total equity', description: 'Every account\'s equity, with the portfolio sparkline.', defaultSpan: 1, singleton: true },
  'pnl-today': { label: 'Today\'s PnL', description: 'Net, with realized underneath.', defaultSpan: 1, singleton: true },
  'running': { label: 'Running strategies', description: 'How many of the configured instances are live.', defaultSpan: 1, singleton: true },
  'runs-24h': { label: '24h runs', description: 'Strategy evaluations and the instructions they emitted.', defaultSpan: 1, singleton: true },
  'portfolio-chart': { label: 'Portfolio equity', description: 'The equity curve across every account.', defaultSpan: 2, singleton: true },
  'agents': { label: 'Active agents', description: 'The first few instances and whether they are running.', defaultSpan: 2, singleton: true },
  'activity': { label: 'Recent activity', description: 'Monitor emits, runs and snapshots, at a glance.', defaultSpan: 2, singleton: true },
  'health': { label: 'System health', description: 'Gateway and runtime.', defaultSpan: 2, singleton: true },
  'monitor-panel': { label: 'Monitor panel', description: 'One chart from one monitor\'s board, for one key.', defaultSpan: 2 },
  'instance': { label: 'Strategy', description: 'One instance: status, today\'s PnL, its last executions.', defaultSpan: 2 },
}

/**
 * The page as it was before any of this existed.
 *
 * An operator who never opens the editor must see exactly what they saw
 * yesterday — a customisable dashboard whose first act is to rearrange itself
 * has spent its credibility before it is used.
 */
export function defaultLayout(): OverviewLayout {
  const w = (kind: WidgetKind): Widget => ({ id: newWidgetId(), kind } as Widget)
  return {
    version: 1,
    widgets: [
      w('equity'), w('pnl-today'), w('running'), w('runs-24h'),
      w('portfolio-chart'), w('agents'), w('activity'), w('health'),
    ],
  }
}

/** Whatever came back from the gateway, made safe to render. */
export function parseLayout(raw: unknown): OverviewLayout {
  if (!raw || typeof raw !== 'object') return defaultLayout()
  const candidate = raw as Partial<OverviewLayout>
  if (!Array.isArray(candidate.widgets)) return defaultLayout()
  // Unknown kinds are dropped rather than rendered as a hole: a layout saved
  // by a newer dashboard should degrade to the widgets this one understands.
  const widgets = candidate.widgets.filter((x): x is Widget =>
    !!x && typeof x === 'object' && typeof (x as Widget).id === 'string' && (x as Widget).kind in KINDS)
  return { version: 1, widgets }
}

export const spanOf = (w: Widget): Span => w.span ?? KINDS[w.kind].defaultSpan

/** The title a widget carries in the editor and in its own header. */
export function titleOf(w: Widget, names: { instances?: Record<string, string>; monitors?: Record<string, string> } = {}): string {
  if (w.kind === 'monitor-panel') {
    return w.title ?? `${names.monitors?.[w.monitorId] ?? w.monitorId} · ${w.panelId}`
  }
  if (w.kind === 'instance') return names.instances?.[w.instanceId] ?? w.instanceId
  return KINDS[w.kind].label
}
