'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { type Drawing, type Tool, type ChartRegion, type ChartYRange, newId, tryCompile, measure, formatSpan, loadDrawings, saveDrawings, rangeMarks } from './chartTools'

export interface ChartCandle { x: number; o: number; h: number; l: number; c: number }
export interface ChartSeries { label: string; points?: Array<{ x: number; y: number }>; candles?: ChartCandle[] }
export type { ChartRegion, ChartYRange }

/**
 * Categorical hues in FIXED order — color follows the series position in the
 * monitor's declaration, never a rank; ≤4 series per panel by design (fold
 * more into separate panels). Candles use the up/down pair instead.
 */
const SERIES_COLORS = ['var(--accent)', '#22c55e', '#eab308', '#38bdf8'] as const
const CANDLE_UP = '#22c55e'
const CANDLE_DOWN = '#ef4444'
/* One hue for everything the reader drew, distinct from all four series
   colours and from up/down — a mark must never be mistaken for data. */
const INK = '#e879f9'
/**
 * Region washes. A region is a fact about the AXIS ("the listing market was
 * shut here"), so it gets a background wash rather than a mark: painted before
 * the gridlines, at the confidence band's weight, with no stroke and no
 * saturation to compete with a curve.
 */
const REGION_COLORS = { neutral: 'var(--muted)', warn: '#f59e0b', good: '#22c55e' } as const
/**
 * A band covers area, so 0.13 is plenty; a 1px reference line at that weight
 * is invisible. Lines get 0.65 — legible as a deliberate mark, still clearly
 * behind the 2px series strokes and dimmer than the reader's own INK guides,
 * which are the marks that must stay loudest.
 */
const REGION_BAND_OPACITY = 0.13
const REGION_LINE_OPACITY = 0.65

const PAD = { top: 14, right: 68, bottom: 30, left: 14 }

function formatValue(v: number, unit?: string, decimals?: number): string {
  const abs = Math.abs(v)
  const num = abs >= 1_000_000 ? `${(v / 1_000_000).toFixed(2)}M`
    : abs >= 10_000 ? `${(v / 1_000).toFixed(1)}k`
    : decimals !== undefined
      ? v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : v.toLocaleString(undefined, { maximumFractionDigits: abs < 1 ? 4 : 2 })
  return unit === '$' ? `$${num}` : unit ? `${num} ${unit}` : num
}

/** Decimals needed to tell values one `step` apart from each other. */
function decimalsForStep(step: number): number {
  if (!isFinite(step) || step <= 0) return 2
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(step))))
}

/**
 * The token's own precision, inferred from the data: the smallest positive
 * gap between distinct observed prices IS (a multiple of) the tick size.
 */
function decimalsFromValues(values: number[], fallback: number): number {
  const unique = [...new Set(values)].sort((a, b) => a - b)
  let minDiff = Infinity
  for (let i = 1; i < unique.length; i++) {
    const d = unique[i]! - unique[i - 1]!
    if (d > 1e-12 && d < minDiff) minDiff = d
  }
  if (!isFinite(minDiff)) return fallback
  return Math.min(8, Math.max(0, Math.ceil(-Math.log10(minDiff * 1.0001))))
}

/**
 * A single instant, at the precision the data actually has.
 *
 * Axis ticks describe a span and round to it; a tooltip describes ONE sample,
 * and rounding that to the minute hides which of a minute's forty samples is
 * being read. Milliseconds appear only when the timestamp carries them, so a
 * second-aligned series is not dressed in three zeroes it does not own.
 */
export function formatInstant(ts: number): string {
  const d = new Date(ts)
  const hms = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const ms = ts % 1000
  return ms === 0 ? hms : `${hms}.${String(Math.abs(ms)).padStart(3, '0')}`
}

function formatTime(ts: number, spanMs: number): string {
  const d = new Date(ts)
  // Millisecond-candle territory: show HH:MM:SS.mmm once the window is tight
  if (spanMs <= 2 * 60_000) {
    const hms = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    return `${hms}.${String(d.getMilliseconds()).padStart(3, '0')}`
  }
  if (spanMs <= 5 * 60_000) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (spanMs <= 48 * 3_600_000) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** Two-sided 95% t critical values by degrees of freedom; ≥30 df → the normal 1.96. */
const T95 = [12.71, 4.30, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23,
  2.20, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.10, 2.09, 2.09,
  2.08, 2.07, 2.07, 2.06, 2.06, 2.06, 2.05, 2.05, 2.05, 2.04]
const tCrit = (df: number): number => (df < 1 ? T95[0]! : df <= 30 ? T95[df - 1]! : 1.96)

let clipCounter = 0

/**
 * Generic chart for monitor plot panels: line series and/or candlesticks, one
 * unit/axis, time or plain-value x-axis, recessive grid, interactive legend
 * (click toggles a series), crosshair + point markers + tooltip on hover,
 * and x-zoom: wheel zooms around the cursor, drag selects a range,
 * double-click (or the Reset pill) restores the full window. The y-axis
 * rescales to what the zoomed window shows. Renders at the container's
 * native pixel width so SVG text keeps its true point size.
 */
export function SeriesChart({ series, regions, yRanges, unit, xKind = 'time', xUnit, height = 220, mode = 'line', storageKey }: {
  series: ChartSeries[]
  /**
   * Shaded x-ranges the monitor declared for this window — sessions, halts,
   * weekends. Context, not data: drawn behind everything, and absent or empty
   * changes nothing about the chart.
   */
  regions?: ChartRegion[]
  /**
   * Shaded y-ranges — cost bands, threshold zones, no-trade corridors. Never
   * an input to the y-domain: see `bandsY`.
   */
  yRanges?: ChartYRange[]
  unit?: string
  xKind?: 'time' | 'value'
  xUnit?: string
  height?: number
  /** 'scatter' = point cloud + OLS trend with its 95% confidence band; connecting a cloud would invent order. */
  mode?: 'line' | 'scatter'
  /** Identity for the reader's own drawings, which persist per chart. Absent = nothing is remembered. */
  storageKey?: string
}) {
  const [hoverX, setHoverX] = useState<number | null>(null)
  const [hoverY, setHoverY] = useState<number | null>(null)
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [width, setWidth] = useState(640)
  const [view, setView] = useState<[number, number] | null>(null)   // zoomed x-domain
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)  // px coords
  /** Grab-and-drag pan: the x-domain at mousedown plus where the grab started. */
  const [pan, setPan] = useState<{ x0: number; x1: number; startPx: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const clipId = useMemo(() => `chart-clip-${++clipCounter}`, [])

  /* ── The reader's own marks ──────────────────────────────────────────────
     A tool takes over the drag: with one armed, dragging draws instead of
     panning, which is the only way both gestures fit on one surface. Tools
     disarm themselves after one use — annotating is occasional, panning is
     constant, so the expensive state to be stuck in is the drawing one. */
  const [tool, setTool] = useState<Tool>('cursor')
  const [drawings, setDrawings] = useState<Drawing[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  /** The shape under construction, in DATA coords. */
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null)
  const [fnOpen, setFnOpen] = useState(false)
  const [fnText, setFnText] = useState('')
  const loaded = useRef(false)
  const keyRef = useRef(storageKey)

  // Loaded after mount, never during render: localStorage does not exist on the
  // server, and marks appearing between the server's HTML and the client's
  // would be a hydration mismatch.
  useEffect(() => {
    keyRef.current = storageKey
    loaded.current = true
    setDrawings(loadDrawings(storageKey))
  }, [storageKey])

  /* Saves follow the DRAWINGS alone, and address the key through a ref.
     Keying this effect on storageKey too would fire it in the same commit as
     the load above — where setDrawings has not landed yet — and write the
     previous panel's marks under the new panel's name. */
  useEffect(() => {
    if (loaded.current) saveDrawings(keyRef.current, drawings)
  }, [drawings])

  // Native-width rendering: track the container so 1 SVG unit = 1 CSS px
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 80) setWidth(Math.round(w))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const W = width
  const H = height
  const plotW = W - PAD.left - PAD.right

  const visible = series.filter(s => !hidden.has(s.label))

  // Full data x-extent (zoom clamps against it)
  const dataDomain = useMemo(() => {
    let x0 = Infinity, x1 = -Infinity
    for (const s of visible) {
      for (const p of s.points ?? []) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x }
      for (const c of s.candles ?? []) { if (c.x < x0) x0 = c.x; if (c.x > x1) x1 = c.x }
    }
    return x0 <= x1 ? [x0, x1] as const : null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, hidden])

  const geom = useMemo(() => {
    if (!dataDomain) return null
    let [x0, x1] = view ?? dataDomain
    if (x1 <= x0) [x0, x1] = dataDomain
    // y-extent from what the window shows (plus line points just outside, for context)
    const ys: number[] = []
    for (const s of visible) {
      for (const p of s.points ?? []) if (p.x >= x0 && p.x <= x1) ys.push(p.y)
      for (const c of s.candles ?? []) if (c.x >= x0 && c.x <= x1) ys.push(c.h, c.l)
    }
    if (ys.length === 0) for (const s of visible) for (const p of s.points ?? []) ys.push(p.y)
    if (ys.length === 0) return null
    let y0 = Math.min(...ys)
    let y1 = Math.max(...ys)
    if (y0 === y1) { y0 -= 1; y1 += 1 }
    const padY = (y1 - y0) * 0.08
    y0 -= padY; y1 += padY
    const px = (x: number) => x1 === x0 ? (PAD.left + plotW / 2) : PAD.left + ((x - x0) / (x1 - x0)) * plotW
    const xAt = (pixel: number) => x0 + ((pixel - PAD.left) / plotW) * (x1 - x0)
    const py = (y: number) => PAD.top + (1 - (y - y0) / (y1 - y0)) * (H - PAD.top - PAD.bottom)
    const yAt = (pixel: number) => y1 - ((pixel - PAD.top) / (H - PAD.top - PAD.bottom)) * (y1 - y0)
    const paths = visible.map(s => (s.points ?? []).map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`).join(' '))
    /**
     * Closed version of each line, for the gradient wash under a lone series.
     * The floor is the ZERO line when the range straddles it — filling a
     * percent series down to the frame bottom would shade "−3%" as if it were
     * as much of something as "+3%".
     */
    const floorY = y0 < 0 && y1 > 0 ? py(0) : H - PAD.bottom
    const areas = visible.map((s, i) => {
      const pts = s.points ?? []
      if (pts.length < 2) return ''
      return `${paths[i]} L${px(pts[pts.length - 1]!.x).toFixed(1)},${floorY.toFixed(1)} L${px(pts[0]!.x).toFixed(1)},${floorY.toFixed(1)} Z`
    })
    const inWindow = (x: number) => x >= x0 && x <= x1
    const candleCount = Math.max(0, ...visible.map(s => (s.candles ?? []).filter(c => inWindow(c.x)).length))
    const candleW = candleCount > 0 ? Math.max(1.5, Math.min(12, (plotW / candleCount) * 0.7)) : 0
    const gridValues = [0, 0.25, 0.5, 0.75, 1].map(f => y0 + f * (y1 - y0))
    const xTicks = [0.02, 0.27, 0.52, 0.77, 0.98].map(f => x0 + f * (x1 - x0))
    // Axis labels: enough digits to separate gridlines. Tooltip: the token's
    // own tick precision, inferred from the visible prices.
    const gridDecimals = decimalsForStep((y1 - y0) / 4)
    const windowValues: number[] = []
    for (const s of visible) {
      for (const p of s.points ?? []) if (p.x >= x0 && p.x <= x1) windowValues.push(p.y)
      for (const c of s.candles ?? []) if (inWindow(c.x)) windowValues.push(c.o, c.h, c.l, c.c)
    }
    const tickDecimals = decimalsFromValues(windowValues, gridDecimals + 1)
    return { px, py, xAt, yAt, paths, areas, gridValues, xTicks, x0, x1, y0, y1, candleW, inWindow, gridDecimals, tickDecimals }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, hidden, view, W, H])

  /**
   * The declared shading, projected onto the window the chart is showing.
   * Recomputed from `geom` like every other mark, which is what keeps a band
   * welded to its data through a zoom or a pan instead of sliding across it.
   */
  const bandsX = useMemo(
    () => (geom ? rangeMarks(regions, geom.x0, geom.x1, geom.px, PAD.left, W - PAD.right) : []),
    [regions, geom, W],
  )
  /**
   * The y mirror — and note what it reads: geom.y0/y1, the domain the SERIES
   * produced. yRanges is deliberately absent from the geom memo above, so a
   * declared band can never widen the axis; one that lies outside what the
   * data spans clips away to nothing here. That is the honest reading: a stop
   * level off the top of the frame means the signal is nowhere near it.
   */
  const bandsY = useMemo(
    () => (geom ? rangeMarks(yRanges, geom.y0, geom.y1, geom.py, PAD.top, H - PAD.bottom) : []),
    [yRanges, geom, H],
  )

  // Wheel zoom needs a non-passive listener to stop the page from scrolling
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !geom || !dataDomain) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const anchor = geom.xAt(e.clientX - rect.left)
      const span = geom.x1 - geom.x0
      const factor = e.deltaY > 0 ? 1.25 : 0.8
      const fullSpan = dataDomain[1] - dataDomain[0]
      const newSpan = Math.min(fullSpan, Math.max(fullSpan / 500, span * factor))
      if (newSpan >= fullSpan) { setView(null); return }
      const ratio = span === 0 ? 0.5 : (anchor - geom.x0) / span
      let n0 = anchor - newSpan * ratio
      let n1 = n0 + newSpan
      if (n0 < dataDomain[0]) { n0 = dataDomain[0]; n1 = n0 + newSpan }
      if (n1 > dataDomain[1]) { n1 = dataDomain[1]; n0 = n1 - newSpan }
      setView([n0, n1])
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [geom, dataDomain])

  /**
   * Pan while the button is held. The listeners live on the WINDOW, not the
   * svg: dragging a chart to its edge naturally takes the cursor outside it,
   * and an svg-scoped mouseup would drop the grab there and leave the chart
   * stuck mid-drag. The window pair also survives releasing over a tooltip.
   */
  useEffect(() => {
    if (!pan || !dataDomain) return
    const span = pan.x1 - pan.x0
    const fullSpan = dataDomain[1] - dataDomain[0]
    const move = (e: MouseEvent) => {
      const rect = svgRef.current?.getBoundingClientRect()
      if (!rect || span <= 0 || plotW <= 0) return
      // Nothing to pan to when the whole history is already on screen
      if (span >= fullSpan) return
      const shift = -(((e.clientX - rect.left) - pan.startPx) / plotW) * span
      let n0 = pan.x0 + shift
      let n1 = pan.x1 + shift
      if (n0 < dataDomain[0]) { n0 = dataDomain[0]; n1 = n0 + span }
      if (n1 > dataDomain[1]) { n1 = dataDomain[1]; n0 = n1 - span }
      setView([n0, n1])
    }
    const up = () => setPan(null)
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [pan, dataDomain, plotW])

  const formatX = (x: number) => xKind === 'time'
    ? formatTime(x, geom ? geom.x1 - geom.x0 : 0)
    : xUnit ? `${x.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${xUnit}` : x.toLocaleString(undefined, { maximumFractionDigits: 2 })

  /** Tooltip x: one sample, so full precision — unlike an axis tick, which labels a span. */
  const formatXExact = (x: number) => xKind === 'time' ? formatInstant(x) : formatX(x)

  /**
   * The point a series contributes AT the hovered instant — or null when the
   * series simply has no data there. Nearest-match alone listed every series
   * at every crosshair position (38 tokens in one tooltip when only a handful
   * settled that hour); a point qualifies only within half the series' own
   * median sampling gap, and a single-point series only on exact hit.
   */
  const pointAt = (pts: Array<{ x: number; y: number }> | undefined, x: number): { x: number; y: number } | null => {
    if (!pts || pts.length === 0) return null
    const nearest = pts.reduce((acc, pt) => (Math.abs(pt.x - x) < Math.abs(acc.x - x) ? pt : acc), pts[0]!)
    if (pts.length === 1) return nearest.x === x ? nearest : null
    const gaps = pts.slice(1).map((pt, i) => pt.x - pts[i]!.x).filter(g => g > 0).sort((a, b) => a - b)
    const medianGap = gaps[Math.floor(gaps.length / 2)] ?? 0
    return Math.abs(nearest.x - x) <= medianGap / 2 + 1e-9 ? nearest : null
  }


  // Hover: nearest x across every visible series, within the window
  const refXs = useMemo(() => {
    const set = new Set<number>()
    for (const s of visible) {
      for (const p of s.points ?? []) set.add(p.x)
      for (const c of s.candles ?? []) set.add(c.x)
    }
    return [...set]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, hidden])

  /**
   * Least-squares trend per series over the VISIBLE points, with the 95%
   * confidence band of the mean response — the band answers "how firmly does
   * this cloud pin the line down", which a bare trend line silently overstates.
   * Fewer than 3 points, or no spread in x, means no defensible fit at all.
   */
  const fits = useMemo(() => {
    if (mode !== 'scatter' || !geom) return []
    return visible.map((s) => {
      const pts = (s.points ?? []).filter(p => geom.inWindow(p.x) && isFinite(p.x) && isFinite(p.y))
      const n = pts.length
      if (n < 3) return null
      const mx = pts.reduce((a, p) => a + p.x, 0) / n
      const my = pts.reduce((a, p) => a + p.y, 0) / n
      let sxx = 0, sxy = 0, syy = 0
      for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy }
      if (sxx <= 0) return null
      const slope = sxy / sxx
      const intercept = my - slope * mx
      const ssRes = pts.reduce((a, p) => { const r = p.y - (intercept + slope * p.x); return a + r * r }, 0)
      const r2 = syy > 0 ? Math.max(0, 1 - ssRes / syy) : 0
      const se = Math.sqrt(ssRes / Math.max(1, n - 2))
      const t = tCrit(n - 2)
      const fit = (x: number) => intercept + slope * x
      const half = (x: number) => t * se * Math.sqrt(1 / n + ((x - mx) ** 2) / sxx)
      const STEPS = 48
      const xs = Array.from({ length: STEPS + 1 }, (_, i) => geom.x0 + (i / STEPS) * (geom.x1 - geom.x0))
      const linePath = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${geom.px(x).toFixed(1)},${geom.py(fit(x)).toFixed(1)}`).join(' ')
      const upper = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${geom.px(x).toFixed(1)},${geom.py(fit(x) + half(x)).toFixed(1)}`).join(' ')
      const lower = [...xs].reverse().map(x => `L${geom.px(x).toFixed(1)},${geom.py(fit(x) - half(x)).toFixed(1)}`).join(' ')
      return { slope, r2, n, linePath, bandPath: `${upper} ${lower} Z` }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, hidden, geom, mode])

  /** Scatter hover is per-POINT (no shared x to cross): nearest mark within 24px. */
  const hoverPt = useMemo(() => {
    if (mode !== 'scatter' || !geom || hoverX === null || hoverY === null || drag) return null
    let best: { label: string; x: number; y: number; color: string; dist: number } | null = null
    for (const s of visible) {
      for (const p of s.points ?? []) {
        if (!geom.inWindow(p.x)) continue
        const d = Math.hypot(geom.px(p.x) - hoverX, geom.py(p.y) - hoverY)
        if (d <= 24 && (!best || d < best.dist)) {
          best = { label: s.label, x: p.x, y: p.y, color: SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length]!, dist: d }
        }
      }
    }
    return best
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, hidden, geom, mode, hoverX, hoverY, drag])

  /**
   * Each function guide, sampled across the plot at 2px steps. Sampled in
   * PIXEL space rather than data space so the curve has the same resolution
   * however far the chart is zoomed, and broken into separate subpaths
   * wherever the formula stops producing a number — sqrt(x) below zero should
   * leave a gap, not a straight line across the discontinuity.
   */
  const fnPaths = useMemo(() => {
    if (!geom) return []
    return drawings.flatMap((d) => {
      if (d.kind !== 'fn') return []
      const compiled = tryCompile(d.expr)
      if ('error' in compiled) return []
      const segs: string[] = []
      let cur: string[] = []
      for (let pxv = PAD.left; pxv <= W - PAD.right; pxv += 2) {
        const y = compiled.fn(fnX(geom.xAt(pxv)))
        if (!isFinite(y)) { if (cur.length > 1) segs.push(cur.join(' ')); cur = []; continue }
        const yy = geom.py(y)
        // Off-frame by a wide margin: keep the subpath, let the clip do the work
        cur.push(`${cur.length === 0 ? 'M' : 'L'}${pxv.toFixed(1)},${Math.max(-1e4, Math.min(1e4, yy)).toFixed(1)}`)
      }
      if (cur.length > 1) segs.push(cur.join(' '))
      return [{ id: d.id, d: segs.join(' ') }]
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawings, geom, W, xKind, dataDomain])

  const hasCandles = series.some(s => (s.candles?.length ?? 0) > 0)
  const fnCompiled = useMemo(() => (fnText.trim() ? tryCompile(fnText) : null), [fnText])
  const fnError = fnCompiled && 'error' in fnCompiled ? fnCompiled.error : null

  function addFn() {
    if (!fnCompiled || 'error' in fnCompiled) return
    setDrawings(d => [...d, { id: newId(), kind: 'fn', expr: fnText.trim() }])
    setFnText('')
    setFnOpen(false)
  }

  let hoveredX: number | null = null
  if (mode === 'line' && geom && hoverX !== null && drag === null && pan === null && draft === null && refXs.length > 0) {
    const inWin = refXs.filter(geom.inWindow)
    const pool = inWin.length > 0 ? inWin : refXs
    hoveredX = pool.reduce((best, x) => Math.abs(geom.px(x) - hoverX) < Math.abs(geom.px(best) - hoverX) ? x : best, pool[0]!)
  }

  function localX(e: React.MouseEvent<SVGSVGElement>): number | null {
    if (!svgRef.current) return null
    return e.clientX - svgRef.current.getBoundingClientRect().left
  }

  function localY(e: React.MouseEvent<SVGSVGElement>): number | null {
    if (!svgRef.current) return null
    return e.clientY - svgRef.current.getBoundingClientRect().top
  }

  /**
   * What `x` means inside a formula.
   *
   * On a time axis the raw value is an epoch in milliseconds, which no one can
   * write a useful formula against — `y = 100 + 0.5*x` would move by half a
   * unit per millisecond. So x is HOURS SINCE the first sample, and a slope is
   * a rate per hour, which is the thing a reader actually has in mind. On a
   * value axis the raw number already is the quantity, so it passes through.
   */
  const fnX = (x: number): number =>
    xKind === 'time' && dataDomain ? (x - dataDomain[0]) / 3_600_000 : x

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const x = localX(e)
    const y = localY(e)
    if (x === null) return
    // While panning the crosshair would chase the cursor across a moving
    // series — all motion, no reading. Suppress it until the grab is released.
    if (pan) { setHoverX(null); setHoverY(null); return }
    setHoverX(x)
    if (y !== null) setHoverY(y)
    if (draft && geom && y !== null) { setDraft({ ...draft, x2: geom.xAt(x), y2: geom.yAt(y) }); return }
    if (drag) setDrag({ from: drag.from, to: x })
  }

  /**
   * Plain drag PANS (the trading-chart convention, and what a zoomed-in chart
   * begs for); shift-drag keeps the box-select zoom, which is the only way to
   * jump straight to a range.
   */
  function onDown(e: React.MouseEvent<SVGSVGElement>) {
    const x = localX(e)
    const y = localY(e)
    if (x === null || y === null) return

    if (tool !== 'cursor' && geom) {
      const dx = geom.xAt(x)
      const dy = geom.yAt(y)
      // A level and an instant are single-click: there is no second point to
      // ask for, and making the reader drag a horizontal line horizontally
      // would be a gesture that carries no information.
      if (tool === 'hline') { setDrawings(d => [...d, { id: newId(), kind: 'hline', y: dy }]); setTool('cursor'); return }
      if (tool === 'vline') { setDrawings(d => [...d, { id: newId(), kind: 'vline', x: dx }]); setTool('cursor'); return }
      setDraft({ x1: dx, y1: dy, x2: dx, y2: dy })
      return
    }

    setSelected(null)
    if (e.shiftKey) { setDrag({ from: x, to: x }); return }
    if (geom) setPan({ x0: geom.x0, x1: geom.x1, startPx: x })
  }

  function onUp() {
    if (draft) {
      // A trend line is kept; a measurement is not. The measure tool answers a
      // question asked in the moment ("how far was that move?") and leaving its
      // box behind would turn every answer into clutter on the next one.
      if (tool === 'trend' && geom) {
        const moved = Math.hypot(geom.px(draft.x2) - geom.px(draft.x1), geom.py(draft.y2) - geom.py(draft.y1))
        if (moved >= 6) setDrawings(d => [...d, { id: newId(), kind: 'trend', ...draft }])
      }
      setDraft(null)
      setTool('cursor')
      return
    }
    if (!drag || !geom) { setDrag(null); return }
    const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)]
    setDrag(null)
    if (b - a < 8) return   // a click, not a selection
    setView([geom.xAt(a), geom.xAt(b)])
  }

  function toggle(label: string) {
    setHidden(prev => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else if (next.size < series.length - 1) next.add(label)   // never hide the last one
      return next
    })
  }

  const lineSeries = series.filter(s => (s.points?.length ?? 0) > 0)
  /** Exactly one curve on screen — the only case where a filled wash reads. */
  const drawn = visible.filter(s => (s.points?.length ?? 0) > 0)
  const soloLine = mode === 'line' && drawn.length === 1
  const washColor = SERIES_COLORS[(soloLine ? series.indexOf(drawn[0]!) : 0) % SERIES_COLORS.length]

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 min-h-[18px]">
        {/* ── Tools ──────────────────────────────────────────────────────
            Guides on every chart; the freehand line and the measure box only
            where there are candles, which is where a reader is reading price
            action rather than a level. */}
        <div className="flex items-center gap-0.5 shrink-0">
          {([
            ['cursor', '↖', 'Cursor — drag to pan, shift-drag to select'],
            ...(hasCandles ? [['trend', '╱', 'Trend line — drag between two points'] as const,
                              ['measure', '⇅', 'Measure — drag over a move for its size, % and duration'] as const] : []),
            ['hline', '─', 'Horizontal guide — click a level'],
            ['vline', '│', 'Vertical guide — click an instant'],
          ] as ReadonlyArray<readonly [Tool, string, string]>).map(([t, glyph, title]) => (
            <button
              key={t}
              onClick={() => { setTool(tool === t ? 'cursor' : t); setFnOpen(false); setDraft(null) }}
              title={title}
              className="text-xs w-6 h-6 rounded cursor-pointer leading-none"
              style={{
                border: `1px solid ${tool === t ? INK : 'var(--border)'}`,
                color: tool === t ? INK : 'var(--muted)',
                background: tool === t ? 'color-mix(in srgb, var(--surface) 70%, transparent)' : 'transparent',
              }}
            >{glyph}</button>
          ))}
          <button
            onClick={() => { setFnOpen(v => !v); setTool('cursor') }}
            title="Function guide — a formula in x"
            className="text-xs h-6 px-1.5 rounded cursor-pointer leading-none italic"
            style={{
              border: `1px solid ${fnOpen ? INK : 'var(--border)'}`,
              color: fnOpen ? INK : 'var(--muted)',
              background: 'transparent',
            }}
          >ƒ(x)</button>
          {drawings.length > 0 && (
            <button
              onClick={() => { setDrawings([]); setSelected(null) }}
              title={`Remove all ${drawings.length} drawing(s)`}
              className="text-xs h-6 px-1.5 rounded cursor-pointer leading-none"
              style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
            >✕ {drawings.length}</button>
          )}
        </div>
        {lineSeries.length >= 2 && lineSeries.map((s) => {
          const i = series.indexOf(s)
          const off = hidden.has(s.label)
          const f = mode === 'scatter' ? fits[visible.indexOf(s)] : null
          return (
            <button
              key={s.label}
              onClick={() => toggle(s.label)}
              className="flex items-center gap-1.5 text-xs cursor-pointer select-none"
              style={{ color: off ? 'var(--border)' : 'var(--muted)', textDecoration: off ? 'line-through' : 'none' }}
              title={off ? 'Show series' : 'Hide series'}
            >
              <span style={{ width: 14, height: 3, borderRadius: 2, background: off ? 'var(--border)' : SERIES_COLORS[i % SERIES_COLORS.length], display: 'inline-block' }} />
              {s.label}
              {f && !off && (
                <span style={{ color: 'var(--border)' }}>
                  · R² {f.r2.toFixed(2)} · {f.slope >= 0 ? '+' : ''}{f.slope.toFixed(f.slope !== 0 && Math.abs(f.slope) < 1 ? 2 : 0)}{unit ? ` ${unit}` : ''}{xUnit ? `/${xUnit}` : ''} · n {f.n}
                </span>
              )}
            </button>
          )
        })}
        {view ? (
          <button
            onClick={() => setView(null)}
            className="ml-auto text-xs px-2 py-0.5 rounded-full cursor-pointer"
            style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }}
            title="Restore the full window (or double-click the chart)"
          >
            ⟲ Reset zoom
          </button>
        ) : (
          // Drag-to-pan is invisible until tried, and shift-drag would never be
          // guessed at all — so the chart says so while it is fully zoomed out.
          <span className="ml-auto text-xs" style={{ color: 'var(--border)' }}>
            {tool === 'trend' ? 'drag between two points · esc to cancel'
              : tool === 'measure' ? 'drag over a move · the box goes when you let go'
              : tool === 'hline' ? 'click a level'
              : tool === 'vline' ? 'click an instant'
              : selected ? 'delete removes the selected drawing'
              : 'scroll to zoom · drag to pan · shift-drag to select'}
          </span>
        )}
      </div>

      {/* The formula bar, open only while it is being used */}
      {fnOpen && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs italic shrink-0" style={{ color: INK }}>y =</span>
          <input
            autoFocus
            value={fnText}
            onChange={(e) => setFnText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addFn()
              if (e.key === 'Escape') { setFnOpen(false); setFnText('') }
            }}
            placeholder={xKind === 'time' ? 'e.g. 100 + 0.5*x   (x = hours since the first sample)' : 'e.g. 2*x + 3'}
            className="flex-1 min-w-0 text-xs px-2 py-1 rounded-md font-mono"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: `1px solid ${fnError ? CANDLE_DOWN : 'var(--border)'}` }}
          />
          <button
            onClick={addFn}
            disabled={!!fnError || !fnText.trim()}
            className="text-xs px-2 py-1 rounded-md cursor-pointer shrink-0"
            style={{ border: `1px solid ${fnError || !fnText.trim() ? 'var(--border)' : INK}`, color: fnError || !fnText.trim() ? 'var(--border)' : INK }}
          >Add</button>
          {fnError && fnText.trim() && (
            <span className="text-xs shrink-0" style={{ color: CANDLE_DOWN }}>{fnError}</span>
          )}
        </div>
      )}

      {!geom ? (
        <p className="text-sm py-8 text-center" style={{ color: 'var(--muted)' }}>No data in window.</p>
      ) : (
        <>
          <svg
            ref={svgRef}
            width={W}
            height={H}
            className="block max-w-full select-none outline-none"
            tabIndex={0}
            style={{ cursor: tool !== 'cursor' ? 'crosshair' : pan ? 'grabbing' : drag ? 'col-resize' : 'grab' }}
            onMouseMove={onMove}
            onMouseDown={onDown}
            onMouseUp={onUp}
            /* pan is torn down by its own window listener — clearing it here
               would drop the grab the moment the drag reaches the edge */
            onMouseLeave={() => { setHoverX(null); setHoverY(null); setDrag(null); setDraft(null) }}
            onDoubleClick={() => setView(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setTool('cursor'); setDraft(null); setSelected(null) }
              if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
                e.preventDefault()
                setDrawings(d => d.filter(x => x.id !== selected))
                setSelected(null)
              }
            }}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={PAD.left} y={0} width={plotW} height={H - PAD.bottom} />
              </clipPath>
              <linearGradient id={`${clipId}-wash`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={washColor} stopOpacity="0.22" />
                <stop offset="100%" stopColor={washColor} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* ── Declared shading ──────────────────────────────────────────
                First in the paint order, so it sits under the grid, under the
                axis labels and under every series — it is what the data
                happened AGAINST. Clipped to the plot area and re-projected
                through the current scales, so a mark holds its ground on its
                axis while the chart is zoomed and panned.

                A zero-extent range is a reference LINE rather than an empty
                band: an instant on x, a level on y. Lines carry no caption —
                a hairline with text pinned beside it would crowd the same
                strip as the crosshair readout and the zero reference — so
                their label rides an invisible 10px hit stroke instead, the
                same trick that makes the reader's own guides clickable. */}
            {(bandsX.length > 0 || bandsY.length > 0) && (
              <g clipPath={`url(#${clipId})`}>
                {bandsX.map((m, i) => {
                  const color = REGION_COLORS[m.tone]
                  const title = m.label ? <title>{m.label}</title> : null
                  if (m.kind === 'line') {
                    return (
                      <g key={`rx-${i}`}>
                        <line x1={m.pos} x2={m.pos} y1={PAD.top} y2={H - PAD.bottom} stroke="transparent" strokeWidth="10">{title}</line>
                        <line
                          x1={m.pos} x2={m.pos} y1={PAD.top} y2={H - PAD.bottom}
                          stroke={color} strokeWidth="1" strokeDasharray="5 4"
                          opacity={REGION_LINE_OPACITY} pointerEvents="none"
                        />
                      </g>
                    )
                  }
                  return (
                    <g key={`rx-${i}`}>
                      <rect
                        x={m.pos} y={PAD.top} width={m.size} height={H - PAD.top - PAD.bottom}
                        fill={color} opacity={REGION_BAND_OPACITY}
                      >{title}</rect>
                      {/* Enough width for the glyphs, or the hover title says it */}
                      {m.label && m.size >= 46 && (
                        <text
                          x={m.pos + m.size / 2} y={PAD.top + 11}
                          fontSize="10" textAnchor="middle" fill={color}
                          opacity="0.75" pointerEvents="none"
                        >{m.label}</text>
                      )}
                    </g>
                  )
                })}
                {bandsY.map((m, i) => {
                  const color = REGION_COLORS[m.tone]
                  const title = m.label ? <title>{m.label}</title> : null
                  if (m.kind === 'line') {
                    return (
                      <g key={`ry-${i}`}>
                        <line x1={PAD.left} x2={W - PAD.right} y1={m.pos} y2={m.pos} stroke="transparent" strokeWidth="10">{title}</line>
                        <line
                          x1={PAD.left} x2={W - PAD.right} y1={m.pos} y2={m.pos}
                          stroke={color} strokeWidth="1" strokeDasharray="5 4"
                          opacity={REGION_LINE_OPACITY} pointerEvents="none"
                        />
                      </g>
                    )
                  }
                  return (
                    <g key={`ry-${i}`}>
                      <rect
                        x={PAD.left} y={m.pos} width={plotW} height={m.size}
                        fill={color} opacity={REGION_BAND_OPACITY}
                      >{title}</rect>
                      {/* A y band is constrained in HEIGHT, not width: one
                          10px line needs ~18px of band, not 46. */}
                      {m.label && m.size >= 18 && (
                        <text
                          x={PAD.left + 6} y={m.pos + 12}
                          fontSize="10" textAnchor="start" fill={color}
                          opacity="0.75" pointerEvents="none"
                        >{m.label}</text>
                      )}
                    </g>
                  )
                })}
              </g>
            )}

            {/* Recessive grid + y tick labels */}
            {geom.gridValues.map((v, gi) => (
              <g key={gi}>
                <line x1={PAD.left} x2={W - PAD.right} y1={geom.py(v)} y2={geom.py(v)} stroke="var(--border)" strokeWidth="1" opacity={gi === 0 || gi === 4 ? 0.4 : 0.7} />
                <text x={W - PAD.right + 6} y={geom.py(v) + 4} fontSize="11" fill="var(--muted)">{formatValue(v, unit, geom.gridDecimals)}</text>
              </g>
            ))}
            {/* Vertical rules under the x labels — they tie a spike to its time
                without competing with the series (hence the low opacity) */}
            {geom.xTicks.map((t, ti) => (
              <line key={`vx-${ti}`} x1={geom.px(t)} x2={geom.px(t)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--border)" strokeWidth="1" opacity="0.28" />
            ))}
            {/* Zero reference when the range crosses it (percent-style panels) */}
            {geom.y0 < 0 && geom.y1 > 0 && (
              <line x1={PAD.left} x2={W - PAD.right} y1={geom.py(0)} y2={geom.py(0)} stroke="var(--muted)" strokeWidth="1" opacity="0.5" strokeDasharray="4 3" />
            )}
            {/* X ticks */}
            {geom.xTicks.map((t, ti) => (
              <text
                key={ti}
                x={geom.px(t)}
                y={H - 8}
                fontSize="11"
                fill="var(--muted)"
                textAnchor={ti === 0 ? 'start' : ti === geom.xTicks.length - 1 ? 'end' : 'middle'}
              >
                {formatX(t)}
              </text>
            ))}

            <g clipPath={`url(#${clipId})`}>
              {/* Candles first (under lines) */}
              {visible.map((s) => (s.candles ?? []).filter(c => geom.inWindow(c.x)).map((c) => {
                const up = c.c >= c.o
                const color = up ? CANDLE_UP : CANDLE_DOWN
                const bodyTop = geom.py(Math.max(c.o, c.c))
                const bodyH = Math.max(1, Math.abs(geom.py(c.o) - geom.py(c.c)))
                const isHover = hoveredX === c.x
                return (
                  <g key={`${s.label}-${c.x}`} opacity={hoveredX !== null && !isHover ? 0.75 : 1}>
                    <line x1={geom.px(c.x)} x2={geom.px(c.x)} y1={geom.py(c.h)} y2={geom.py(c.l)} stroke={color} strokeWidth="1" />
                    <rect x={geom.px(c.x) - geom.candleW / 2} y={bodyTop} width={geom.candleW} height={bodyH} fill={color} rx="1" />
                  </g>
                )
              }))}

              {/* Series: a connected line, or a scatter cloud under its fitted trend */}
              {mode === 'scatter' ? (
                <>
                  {visible.map((s, vi) => {
                    const f = fits[vi]
                    if (!f) return null
                    const color = SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length]
                    return (
                      <g key={`fit-${s.label}`}>
                        <path d={f.bandPath} fill={color} opacity="0.13" />
                        <path d={f.linePath} fill="none" stroke={color} strokeWidth="2" strokeDasharray="6 4" opacity="0.9" />
                      </g>
                    )
                  })}
                  {visible.map((s) => {
                    const color = SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length]
                    return (s.points ?? []).filter(p => geom.inWindow(p.x)).map((p, i) => (
                      <circle
                        key={`${s.label}-${i}`}
                        cx={geom.px(p.x)} cy={geom.py(p.y)} r="4"
                        fill={color} fillOpacity="0.62"
                        stroke="var(--surface)" strokeWidth="1.5"
                      />
                    ))
                  })}
                  {hoverPt && (
                    <circle cx={geom.px(hoverPt.x)} cy={geom.py(hoverPt.y)} r="5.5" fill={hoverPt.color} stroke="var(--foreground)" strokeWidth="1.5" />
                  )}
                </>
              ) : (
                visible.map((s, vi) => (s.points?.length ?? 0) > 0 && (
                  <g key={s.label}>
                    {/* A single curve gets a wash under it — with several series
                        overlapping fills turn into mud, so only the lone case */}
                    {soloLine && geom.areas[vi] && (
                      <path d={geom.areas[vi]!} fill={`url(#${clipId}-wash)`} stroke="none" />
                    )}
                    <path d={geom.paths[vi]!} fill="none" stroke={SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                ))
              )}

              {/* ── The reader's own marks ────────────────────────────────
                  Drawn last, so an annotation is never buried under the data
                  it annotates. Each shape carries an invisible fat stroke
                  beneath it: a 1.5px line is almost impossible to click, and
                  a mark you cannot select is a mark you cannot delete. */}
              {drawings.map((d) => {
                const on = selected === d.id
                const w = on ? 2.5 : 1.5
                const hit = (node: React.ReactNode, key: string) => (
                  <g key={key} onMouseDown={(e) => { e.stopPropagation(); setSelected(d.id) }} style={{ cursor: 'pointer' }}>
                    {node}
                  </g>
                )
                if (d.kind === 'hline') {
                  const y = geom.py(d.y)
                  return hit(
                    <>
                      <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke="transparent" strokeWidth="10" />
                      <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} stroke={INK} strokeWidth={w} strokeDasharray="6 4" opacity={on ? 1 : 0.85} />
                    </>, d.id)
                }
                if (d.kind === 'vline') {
                  const x = geom.px(d.x)
                  return hit(
                    <>
                      <line x1={x} x2={x} y1={PAD.top} y2={H - PAD.bottom} stroke="transparent" strokeWidth="10" />
                      <line x1={x} x2={x} y1={PAD.top} y2={H - PAD.bottom} stroke={INK} strokeWidth={w} strokeDasharray="6 4" opacity={on ? 1 : 0.85} />
                    </>, d.id)
                }
                if (d.kind === 'trend') {
                  const [x1, y1, x2, y2] = [geom.px(d.x1), geom.py(d.y1), geom.px(d.x2), geom.py(d.y2)]
                  return hit(
                    <>
                      <line x1={x1} x2={x2} y1={y1} y2={y2} stroke="transparent" strokeWidth="12" />
                      <line x1={x1} x2={x2} y1={y1} y2={y2} stroke={INK} strokeWidth={w} strokeLinecap="round" opacity={on ? 1 : 0.9} />
                      {on && (
                        <>
                          <circle cx={x1} cy={y1} r="4" fill={INK} stroke="var(--surface)" strokeWidth="1.5" />
                          <circle cx={x2} cy={y2} r="4" fill={INK} stroke="var(--surface)" strokeWidth="1.5" />
                        </>
                      )}
                    </>, d.id)
                }
                const path = fnPaths.find(f => f.id === d.id)
                if (!path || !path.d) return null
                return hit(
                  <>
                    <path d={path.d} fill="none" stroke="transparent" strokeWidth="12" />
                    <path d={path.d} fill="none" stroke={INK} strokeWidth={w} strokeLinejoin="round" opacity={on ? 1 : 0.9} />
                  </>, d.id)
              })}

              {/* In progress: a trend line being drawn, or a measurement */}
              {draft && tool === 'trend' && (
                <line
                  x1={geom.px(draft.x1)} y1={geom.py(draft.y1)}
                  x2={geom.px(draft.x2)} y2={geom.py(draft.y2)}
                  stroke={INK} strokeWidth="1.5" strokeDasharray="5 4" opacity="0.9"
                />
              )}
              {draft && tool === 'measure' && (() => {
                const m = measure(draft.y1, draft.y2, draft.x1, draft.x2)
                const c = m.up ? CANDLE_UP : CANDLE_DOWN
                const [ax, bx] = [geom.px(draft.x1), geom.px(draft.x2)]
                const [ay, by] = [geom.py(draft.y1), geom.py(draft.y2)]
                return (
                  <g>
                    <rect
                      x={Math.min(ax, bx)} y={Math.min(ay, by)}
                      width={Math.abs(bx - ax)} height={Math.abs(by - ay)}
                      fill={c} opacity="0.13" stroke={c} strokeWidth="1"
                    />
                    <line x1={ax} x2={bx} y1={ay} y2={ay} stroke={c} strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
                    <line x1={bx} x2={bx} y1={ay} y2={by} stroke={c} strokeWidth="1.5" />
                  </g>
                )
              })()}
            </g>

            {/* Drag selection */}
            {drag && Math.abs(drag.to - drag.from) >= 2 && (
              <rect
                x={Math.min(drag.from, drag.to)}
                y={PAD.top}
                width={Math.abs(drag.to - drag.from)}
                height={H - PAD.top - PAD.bottom}
                fill="var(--accent)"
                opacity="0.15"
                stroke="var(--accent)"
                strokeWidth="1"
              />
            )}

            {/* Horizontal crosshair + the level it sits on, read off the axis.
                Reading a spike's height off gridlines alone is guesswork. */}
            {hoverY !== null && drag === null && pan === null && hoverY > PAD.top && hoverY < H - PAD.bottom && (
              <g>
                <line x1={PAD.left} x2={W - PAD.right} y1={hoverY} y2={hoverY} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" opacity="0.45" />
                <rect x={W - PAD.right + 2} y={hoverY - 9} width={PAD.right - 4} height={18} rx="3" fill="var(--surface)" stroke="var(--border)" />
                <text x={W - PAD.right + 6} y={hoverY + 4} fontSize="11" fill="var(--foreground)">
                  {formatValue(geom.yAt(hoverY), unit, geom.gridDecimals)}
                </text>
              </g>
            )}

            {/* Crosshair + point markers */}
            {hoveredX !== null && (
              <g>
                <line x1={geom.px(hoveredX)} x2={geom.px(hoveredX)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--muted)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
                {visible.map((s) => {
                  const p = pointAt(s.points, hoveredX)
                  if (!p) return null
                  return (
                    <circle
                      key={s.label}
                      cx={geom.px(p.x)} cy={geom.py(p.y)} r="3.5"
                      fill={SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length]}
                      stroke="var(--surface)" strokeWidth="1.5"
                    />
                  )
                })}
              </g>
            )}
          </svg>

          {/* The measurement, beside the point the drag ended on. Three numbers,
              because "how big was that move" is asked in price, in percent and
              in time, and answering one of the three invites the other two. */}
          {draft && tool === 'measure' && geom && (() => {
            const m = measure(draft.y1, draft.y2, draft.x1, draft.x2)
            const c = m.up ? CANDLE_UP : CANDLE_DOWN
            const ex = geom.px(draft.x2)
            return (
              <div
                className="absolute pointer-events-none px-2.5 py-1.5 rounded-md text-xs whitespace-nowrap shadow-lg font-mono"
                style={{
                  left: `${Math.min(Math.max((ex / W) * 100, 2), 98)}%`,
                  top: Math.max(4, Math.min(geom.py(draft.y2), H - 70)),
                  transform: ex > W * 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
                  background: 'var(--surface)', border: `1px solid ${c}`, color: 'var(--foreground)', zIndex: 11,
                }}
              >
                <div style={{ color: c }}>
                  {m.dy >= 0 ? '+' : ''}{formatValue(m.dy, unit, geom.tickDecimals)}
                  {'  '}({m.dyPct >= 0 ? '+' : ''}{m.dyPct.toFixed(2)}%)
                </div>
                <div style={{ color: 'var(--muted)' }}>
                  {xKind === 'time' ? formatSpan(m.dx) : `${m.dx.toLocaleString(undefined, { maximumFractionDigits: 2 })}${xUnit ? ` ${xUnit}` : ''}`}
                </div>
              </div>
            )
          })()}

          {hoverPt && geom && (
            <div
              className="absolute pointer-events-none px-3 py-2 rounded-md text-xs whitespace-nowrap shadow-lg"
              style={{
                left: `${Math.min(Math.max((geom.px(hoverPt.x) / W) * 100, 2), 98)}%`,
                top: Math.max(4, geom.py(hoverPt.y) - 56),
                transform: geom.px(hoverPt.x) > W * 0.65 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
                zIndex: 10,
              }}
            >
              <div className="flex items-center gap-2">
                <span style={{ width: 10, height: 10, borderRadius: 9999, background: hoverPt.color, display: 'inline-block' }} />
                <span style={{ color: 'var(--muted)' }}>{hoverPt.label}</span>
              </div>
              <div className="font-mono mt-0.5">{formatValue(hoverPt.y, unit, geom.tickDecimals)}</div>
              <div style={{ color: 'var(--muted)' }}>{formatXExact(hoverPt.x)}</div>
            </div>
          )}

          {hoveredX !== null && (
            <div
              className="absolute pointer-events-none px-3 py-2 rounded-md text-xs whitespace-nowrap shadow-lg"
              style={{
                left: `${Math.min(Math.max((geom.px(hoveredX) / W) * 100, 2), 98)}%`,
                top: 26,
                transform: geom.px(hoveredX) > W * 0.65 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
                zIndex: 10,
              }}
            >
              {/* hoveredX is snapped to a real sample (see refXs), so this is
                  an observation's own timestamp — worth showing in full. */}
              <div className="mb-1 font-medium" style={{ color: 'var(--muted)' }}>{formatXExact(hoveredX)}</div>
              {visible.map((s) => {
                if (s.candles?.length) {
                  const c = s.candles.reduce((best, cc) => Math.abs(cc.x - hoveredX!) < Math.abs(best.x - hoveredX!) ? cc : best, s.candles[0]!)
                  // Change = close vs open; range = the candle's full travel,
                  // both relative to the open — the numbers a settlement
                  // microstructure reader actually compares candles by.
                  const changePct = c.o !== 0 ? ((c.c - c.o) / c.o) * 100 : 0
                  const rangePct = c.o !== 0 ? ((c.h - c.l) / c.o) * 100 : 0
                  return (
                    <div key={s.label} className="flex items-center gap-2 py-0.5 flex-wrap">
                      <span style={{ color: 'var(--muted)' }}>{s.label}</span>
                      <span>O {formatValue(c.o, unit, geom.tickDecimals)}</span>
                      <span style={{ color: CANDLE_UP }}>H {formatValue(c.h, unit, geom.tickDecimals)}</span>
                      <span style={{ color: CANDLE_DOWN }}>L {formatValue(c.l, unit, geom.tickDecimals)}</span>
                      <span>C {formatValue(c.c, unit, geom.tickDecimals)}</span>
                      <span style={{ color: changePct >= 0 ? CANDLE_UP : CANDLE_DOWN }}>
                        Δ {changePct >= 0 ? '+' : ''}{changePct.toFixed(3)}%
                      </span>
                      <span style={{ color: 'var(--muted)' }}>R {rangePct.toFixed(3)}%</span>
                    </div>
                  )
                }
                const p = pointAt(s.points, hoveredX)
                return p ? (
                  <div key={s.label} className="flex items-center gap-2 py-0.5">
                    <span style={{ width: 10, height: 3, borderRadius: 2, background: SERIES_COLORS[series.indexOf(s) % SERIES_COLORS.length], display: 'inline-block' }} />
                    <span style={{ color: 'var(--muted)' }}>{s.label}</span>
                    <span className="ml-auto font-mono">{formatValue(p.y, unit, geom.tickDecimals)}</span>
                  </div>
                ) : null
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}
