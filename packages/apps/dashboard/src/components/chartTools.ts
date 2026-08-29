/**
 * Everything drawn on a chart that is not a series: the annotations a reader
 * adds (lines, reference guides, the arithmetic behind the measure tool), and
 * the shaded x-ranges a monitor declares behind its data.
 *
 * Every shape is stored in DATA coordinates, never pixels. A drawing pinned to
 * pixels slides off the thing it marks the moment the chart is zoomed or
 * panned, which is exactly when a reader is looking hardest at it — and a
 * region, whose whole job is to say WHERE on the axis something held, is the
 * same bargain: it is projected through the chart's current x-scale on every
 * render, so zooming moves it with the data rather than under it.
 */

export type Drawing =
  /** Two points, joined. The freehand trend line. */
  | { id: string; kind: 'trend'; x1: number; y1: number; x2: number; y2: number }
  /** A level: constant y across the frame. */
  | { id: string; kind: 'hline'; y: number }
  /** An instant: constant x down the frame. */
  | { id: string; kind: 'vline'; x: number }
  /** y = f(x), sampled across whatever is on screen. */
  | { id: string; kind: 'fn'; expr: string }

export type Tool = 'cursor' | 'trend' | 'hline' | 'vline' | 'measure'

export const newId = (): string => Math.random().toString(36).slice(2, 9)

/* ── The function guide ──────────────────────────────────────────────────────
 *
 * Parsed rather than `eval`'d or `new Function`'d. The input is the reader's
 * own, so this is not about untrusted code — it is that a parser can REFUSE.
 * `new Function` accepts `while(1){}` and anything else in scope; a grammar
 * that knows only arithmetic can say "that is not a formula" and put the error
 * under the input, where a typo belongs.
 */

type Node = (x: number) => number

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  exp: Math.exp, sqrt: Math.sqrt, abs: Math.abs,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow,
}

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 }

type Token = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'op'; v: string }

function tokenize(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (ch === ' ' || ch === '\t') { i++; continue }
    if (/[0-9.]/.test(ch)) {
      let j = i
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++
      // Exponent notation, so 1e-3 is one number and not `1e` minus `3`
      if (j < src.length && /[eE]/.test(src[j]!) && /[0-9+-]/.test(src[j + 1] ?? '')) {
        j += 2
        while (j < src.length && /[0-9]/.test(src[j]!)) j++
      }
      const v = Number(src.slice(i, j))
      if (!isFinite(v)) throw new Error(`not a number: ${src.slice(i, j)}`)
      out.push({ t: 'num', v })
      i = j
      continue
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let j = i
      while (j < src.length && /[a-zA-Z_0-9]/.test(src[j]!)) j++
      out.push({ t: 'name', v: src.slice(i, j).toLowerCase() })
      i = j
      continue
    }
    if ('+-*/%^(),'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue }
    throw new Error(`unexpected character ${ch}`)
  }
  return out
}

const BINARY: Record<string, { prec: number; right?: boolean; apply: (a: number, b: number) => number }> = {
  '+': { prec: 1, apply: (a, b) => a + b },
  '-': { prec: 1, apply: (a, b) => a - b },
  '*': { prec: 2, apply: (a, b) => a * b },
  '/': { prec: 2, apply: (a, b) => a / b },
  '%': { prec: 2, apply: (a, b) => a % b },
  '^': { prec: 3, right: true, apply: (a, b) => a ** b },
}

/**
 * Precedence climbing. Returns a closure of x rather than a tree: the guide is
 * sampled a couple of hundred times per redraw, and a closure costs one call
 * per sample where walking a tree costs one per node.
 */
export function compileExpr(src: string): Node {
  // `y = …` is how a person writes a formula; accept it and drop the label.
  // Before tokenizing, since `=` is not part of the grammar.
  const toks = tokenize(src.replace(/^\s*y\s*=/i, ''))
  let p = 0
  const peek = (): Token | undefined => toks[p]
  const eat = (v: string): boolean => {
    const t = peek()
    if (t && t.t === 'op' && t.v === v) { p++; return true }
    return false
  }
  const expect = (v: string): void => {
    if (!eat(v)) throw new Error(`expected ${v}`)
  }

  function primary(): Node {
    const t = peek()
    if (!t) throw new Error('unexpected end')
    if (t.t === 'op' && t.v === '-') { p++; const n = unary(); return (x) => -n(x) }
    if (t.t === 'op' && t.v === '+') { p++; return unary() }
    if (t.t === 'op' && t.v === '(') { p++; const n = expr(0); expect(')'); return n }
    if (t.t === 'num') { p++; const v = t.v; return () => v }
    if (t.t === 'name') {
      p++
      const name = t.v
      if (eat('(')) {
        const args: Node[] = []
        if (!eat(')')) {
          do { args.push(expr(0)) } while (eat(','))
          expect(')')
        }
        const fn = FUNCS[name]
        if (!fn) throw new Error(`unknown function ${name}`)
        return (x) => fn(...args.map(a => a(x)))
      }
      if (name === 'x') return (x) => x
      const c = CONSTS[name]
      if (c !== undefined) return () => c
      throw new Error(`unknown name ${name}`)
    }
    throw new Error(`unexpected ${t.v}`)
  }

  function unary(): Node {
    return primary()
  }

  function expr(minPrec: number): Node {
    let left = unary()
    for (;;) {
      const t = peek()
      if (!t || t.t !== 'op') break
      const op = BINARY[t.v]
      if (!op || op.prec < minPrec) break
      p++
      const right = expr(op.right ? op.prec : op.prec + 1)
      const apply = op.apply
      const l = left
      left = (x) => apply(l(x), right(x))
    }
    return left
  }

  const out = expr(0)
  if (p < toks.length) throw new Error(`unexpected ${toks[p]!.v}`)
  // One evaluation up front: a formula that cannot produce a number at all is
  // an error the reader should see now, not an empty curve they puzzle over.
  const probe = out(1)
  if (typeof probe !== 'number') throw new Error('not a number')
  return out
}

/** Compile, or say why not. */
export function tryCompile(src: string): { fn: Node } | { error: string } {
  if (!src.trim()) return { error: 'empty' }
  try {
    return { fn: compileExpr(src) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid' }
  }
}

/* ── The measure tool ───────────────────────────────────────────────────────*/

export interface Measurement {
  dy: number
  /** Change relative to where the drag STARTED — the denominator a reader means. */
  dyPct: number
  dx: number
  up: boolean
}

export function measure(y1: number, y2: number, x1: number, x2: number): Measurement {
  const dy = y2 - y1
  return {
    dy,
    dyPct: y1 === 0 ? 0 : (dy / Math.abs(y1)) * 100,
    dx: x2 - x1,
    up: dy >= 0,
  }
}

/** A duration a person reads at a glance, from milliseconds. */
export function formatSpan(ms: number): string {
  const s = Math.abs(ms) / 1000
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  const m = s / 60
  if (m < 90) return `${m.toFixed(m < 10 ? 1 : 0)}m`
  const h = m / 60
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)}h`
  return `${(h / 24).toFixed(1)}d`
}

/* ── Persistence ────────────────────────────────────────────────────────────
 *
 * Drawings are a reader's own marks on their own screen, so they live in
 * localStorage rather than travelling to the gateway: nothing here is worth a
 * write to the engine's database, and a mark one person put on a chart is not
 * a fact about the monitor.
 */

const KEY = (id: string): string => `ow.chart.drawings.${id}`

export function loadDrawings(storageKey: string | undefined): Drawing[] {
  if (!storageKey) return []
  try {
    const raw = localStorage.getItem(KEY(storageKey))
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as Drawing[]) : []
  } catch {
    return []
  }
}

export function saveDrawings(storageKey: string | undefined, drawings: Drawing[]): void {
  if (!storageKey) return
  try {
    if (drawings.length === 0) localStorage.removeItem(KEY(storageKey))
    else localStorage.setItem(KEY(storageKey), JSON.stringify(drawings))
  } catch { /* private mode, or full — the marks are not worth an error */ }
}

/* ── Declared regions ───────────────────────────────────────────────────────
 *
 * A monitor can hand the panel shaded x-ranges — the hours a listing market
 * was open, a maintenance halt, the stretch that came from a backfill. They
 * arrive with the series (resolved server-side, like `options`) and are
 * CONTEXT: they say what was true of the axis there, and must never be
 * mistaken for a reading.
 */

/** A shaded x-range declared by the monitor, in data coordinates. */
export interface ChartRegion {
  /** x start, inclusive. */
  from: number
  /** x end, exclusive. */
  to: number
  label?: string
  tone?: 'neutral' | 'warn' | 'good'
}

/** One region resolved to the pixels it occupies right now. */
export interface RegionRect {
  x: number
  width: number
  tone: 'neutral' | 'warn' | 'good'
  label?: string
}

/**
 * Project regions onto the CURRENT x-window.
 *
 * The window is the zoom/pan state, so this runs on every view change and a
 * band stays welded to its data. Three things are dropped rather than drawn:
 * a degenerate range (`from >= to`, including NaNs, which compare false), one
 * that ends before the window starts or begins after it ends, and one that
 * survives clamping as less than a pixel — a hairline of wash reads as a
 * rendering artefact, not as a period.
 */
export function regionRects(
  regions: ChartRegion[] | undefined,
  x0: number,
  x1: number,
  px: (x: number) => number,
  leftPx: number,
  rightPx: number,
): RegionRect[] {
  if (!regions?.length || !(x1 > x0)) return []
  const out: RegionRect[] = []
  for (const r of regions) {
    if (!(r.from < r.to)) continue
    if (r.to <= x0 || r.from >= x1) continue
    // Clamp in DATA space first: px() is unbounded, and a region spanning a
    // decade of epochs would otherwise produce a rect megapixels wide.
    const left = Math.max(leftPx, px(Math.max(r.from, x0)))
    const right = Math.min(rightPx, px(Math.min(r.to, x1)))
    if (right - left < 1) continue
    out.push({
      x: left,
      width: right - left,
      tone: r.tone ?? 'neutral',
      ...(r.label !== undefined ? { label: r.label } : {}),
    })
  }
  return out
}
