export interface MonitorRecord<TData = Record<string, unknown>> {
  ts: number
  data: TData
}

export interface MonitorDataReader<TData = Record<string, unknown>> {
  /** List all keys that have data stored for this monitor. */
  keys(): Promise<string[]>

  readLast(key: string, n: number): Promise<MonitorRecord<TData>[]>

  /**
   * Every stored record for a key, oldest first — no caller-side cap.
   *
   * For consumers that fit over history: a default window silently truncates
   * the evidence, and the truncation is invisible in the result.
   */
  readAll(key: string): Promise<MonitorRecord<TData>[]>
  readLatest(key: string): Promise<MonitorRecord<TData> | null>
  readRange(key: string, from: number, to: number): Promise<MonitorRecord<TData>[]>
  count(key: string): Promise<number>
  stream(key: string): AsyncIterable<MonitorRecord<TData>>

  /**
   * True when this key's store is too large to slurp — DISPLAY layers cap
   * their windows on this instead of asking for everything. Optional: absent
   * on readers that never face large files.
   */
  isOversized?(key: string): Promise<boolean>

  /** Read the latest record for every available key. */
  readAllLatest(): Promise<Map<string, MonitorRecord<TData> | null>>
  /** Read the last n records for every available key. */
  readAllLast(n: number): Promise<Map<string, MonitorRecord<TData>[]>>
}

export type EmitHandler<TData = Record<string, unknown>> = (
  key: string,
  data: TData
) => void | Promise<void>

export interface MonitorOptions {
  dataDir?: string
}

// ── Monitor plotter convention ────────────────────────────────────────────────
//
// A monitor MAY override plots() to declare dashboard panels — the same
// self-description pattern as keySchema/emitSchema. Each definition curates a
// window of the monitor's persisted records into plottable series; extract()
// runs SERVER-SIDE (arbitrary TS curation), the dashboard only receives
// finished series and renders them with a generic chart.
//
// One definition = one panel = ONE unit/axis. Data of different units
// (spread bps vs an imbalance ratio) belongs in separate definitions, never
// on a dual axis.

export interface PlotPoint {
  /** x value: epoch ms for time axes, or a plain number when xKind is 'value'. */
  x: number
  y: number
}

/** One candlestick (kind 'candles'): open/high/low/close at bucket start x. */
export interface PlotCandle {
  x: number
  o: number
  h: number
  l: number
  c: number
}

export interface PlotSeries {
  label: string
  points?: PlotPoint[]
  candles?: PlotCandle[]
}

/**
 * A shaded x-range drawn behind the series — sessions, weekends, halts.
 *
 * A stretch of the x-axis that is CONTEXT for the data rather than data
 * itself: the hours the listing market was open, a maintenance window, the
 * span that came from a backfill instead of the live feed. Encoding one as an
 * extra series does not work — a series is a single path, so points that exist
 * only on weekends draw straight segments across every weekday gap.
 */
export interface PlotRegion {
  /** x start, inclusive. Epoch ms on a time axis, plain number when xKind is 'value'. */
  from: number
  /** x end, exclusive. */
  to: number
  /** Shown on hover / in the legend. */
  label?: string
  /** Optional tone hint; the dashboard picks the actual colour. Default 'neutral'. */
  tone?: 'neutral' | 'warn' | 'good'
}

/** A selectable variant of a panel (e.g. one captured session among many). */
export interface PlotOption {
  value: string
  label: string
  /**
   * Pre-selected when the viewer has not chosen anything. Only meaningful on
   * `multi` panels, where "the first option" is a poor default — a panel that
   * naturally shows several series (a global curve plus a few tokens) marks
   * exactly those. Single-select panels default to the first option.
   */
  default?: boolean
}

interface PlotDefBase<TData> {
  /** Panel id, unique within the monitor. */
  id: string
  title: string
  /**
   * Chart form. 'candles' series carry PlotCandle[] instead of points.
   * 'table' renders each series as a ROW (label = row name, points[i].y =
   * the i-th cell) under the headers declared in `columns`.
   */
  kind: 'line' | 'bar' | 'candles' | 'table' | 'scatter'
  /** Column headers for kind 'table' — cell i of a row is points[i].y. */
  columns?: string[]
  /** y-axis unit hint shown on labels ('$', 'bps', '%', …). */
  unit?: string
  /** x-axis semantics: 'time' (epoch ms, default) or 'value' (plain number, e.g. bp offsets). */
  xKind?: 'time' | 'value'
  /** x-axis unit hint when xKind is 'value'. */
  xUnit?: string
  description?: string
  /**
   * Selectable variants derived from the same record window (e.g. one entry
   * per captured session, or the tokens present in it). When present the
   * dashboard renders a picker and passes the choice to extract.
   */
  options?(records: MonitorRecord<TData>[]): PlotOption[]
  /**
   * Shaded x-ranges derived SERVER-side from the same record window, drawn
   * behind the series. Same idiom as `options`: the runtime calls it with the
   * window it is about to render.
   */
  regions?(records: MonitorRecord<TData>[]): PlotRegion[]
}

/**
 * One-of-many: the options are alternative VIEWS of the panel (which captured
 * session to display), where showing two at once would be meaningless.
 */
export interface SinglePlotDef<TData = Record<string, unknown>> extends PlotDefBase<TData> {
  multi?: false
  /**
   * Curate an ascending-time window of records into named series. `option` is
   * the chosen value — never absent from options(), since the runtime
   * resolves the viewer's request against the live list first.
   */
  extract(records: MonitorRecord<TData>[], option?: string): PlotSeries[]
}

/**
 * Many-at-once: the options are SERIES sharing the panel's axis (tokens on a
 * normalized curve), so the picker is a filter over what to draw.
 */
export interface MultiPlotDef<TData = Record<string, unknown>> extends PlotDefBase<TData> {
  multi: true
  /**
   * Curate an ascending-time window of records into named series. `option`
   * holds the chosen values — never empty and never stale: the runtime
   * resolves the request against the live option list and the `default`
   * flags before calling this.
   */
  extract(records: MonitorRecord<TData>[], option?: string[]): PlotSeries[]
}

/**
 * A dashboard panel. Declaring `multi: true` types `extract`'s option
 * argument as an array — single-select panels keep the plain string, so
 * adding multi-select cost existing panels nothing.
 */
export type MonitorPlotDef<TData = Record<string, unknown>> = SinglePlotDef<TData> | MultiPlotDef<TData>

/** Serializable panel metadata (everything except extract). */
export interface MonitorPlotInfo {
  id: string
  title: string
  kind: 'line' | 'bar' | 'candles' | 'table' | 'scatter'
  columns?: string[]
  unit?: string
  xKind?: 'time' | 'value'
  xUnit?: string
  description?: string
  /** Options are a multi-select filter rather than one-of-many variants. */
  multi?: boolean
}
