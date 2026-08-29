import { describe, it, expect } from 'vitest'
import { rangeMarks, type ChartRegion, type ChartYRange } from '../chartTools'

/**
 * The two axes go through one projector, so every case is stated twice: once
 * with an INCREASING map (x: data grows rightwards) and once with a DECREASING
 * one (y: data grows upwards while pixels grow downwards). A rule that only
 * holds on x is a bug waiting for the first stop level.
 */

/** x: [x0,x1] → [left,right], the shape of geom.px. */
const xProject = (x0: number, x1: number, left: number, right: number) =>
  (v: number) => left + ((v - x0) / (x1 - x0)) * (right - left)

/** y: [y0,y1] → [bottom,top], the shape of geom.py — decreasing. */
const yProject = (y0: number, y1: number, top: number, bottom: number) =>
  (v: number) => top + (1 - (v - y0) / (y1 - y0)) * (bottom - top)

describe('bands', () => {
  it('projects an x band onto the pixels it covers', () => {
    const px = xProject(0, 100, 0, 200)
    const marks = rangeMarks([{ from: 20, to: 40, label: 'closed', tone: 'warn' }], 0, 100, px, 0, 200)
    expect(marks).toEqual([{ kind: 'band', pos: 40, size: 40, tone: 'warn', label: 'closed' }])
  })

  it('projects a y band the same way despite the inverted axis', () => {
    const py = yProject(0, 100, 0, 200)
    const marks = rangeMarks([{ from: 20, to: 40, label: 'no-trade' }], 0, 100, py, 0, 200)
    // y 20..40 sits BELOW y 40..100, so its pixels start at the far side
    expect(marks).toEqual([{ kind: 'band', pos: 120, size: 40, tone: 'neutral', label: 'no-trade' }])
  })

  it('clamps a band that overhangs the window instead of running off the canvas', () => {
    const px = xProject(0, 100, 0, 200)
    const marks = rangeMarks([{ from: -1e12, to: 1e12 }], 0, 100, px, 0, 200)
    expect(marks).toEqual([{ kind: 'band', pos: 0, size: 200, tone: 'neutral' }])
  })

  it('defaults the tone to neutral and omits an absent label', () => {
    const px = xProject(0, 100, 0, 200)
    const [m] = rangeMarks([{ from: 10, to: 50 }], 0, 100, px, 0, 200)
    expect(m!.tone).toBe('neutral')
    expect('label' in m!).toBe(false)
  })
})

describe('the zero-extent convention', () => {
  it('from === to yields a LINE on x, not an empty band', () => {
    const px = xProject(1000, 1100, 0, 200)
    const marks = rangeMarks([{ from: 1050, to: 1050, label: 'anchor reset' }], 1000, 1100, px, 0, 200)
    expect(marks).toEqual([{ kind: 'line', pos: 100, size: 0, tone: 'neutral', label: 'anchor reset' }])
  })

  it('from === to yields a LINE on y, not an empty band', () => {
    const py = yProject(-1, 1, 0, 200)
    const marks = rangeMarks([{ from: 0, to: 0, label: 'stop', tone: 'warn' }], -1, 1, py, 0, 200)
    expect(marks).toEqual([{ kind: 'line', pos: 100, size: 0, tone: 'warn', label: 'stop' }])
  })

  it('drops a line that falls outside the window, on either axis', () => {
    const px = xProject(0, 100, 0, 200)
    const py = yProject(0, 100, 0, 200)
    expect(rangeMarks([{ from: 200, to: 200 }], 0, 100, px, 0, 200)).toEqual([])
    expect(rangeMarks([{ from: -5, to: -5 }], 0, 100, py, 0, 200)).toEqual([])
  })

  it('keeps a line at the very edge of the window', () => {
    const px = xProject(0, 100, 0, 200)
    expect(rangeMarks([{ from: 0, to: 0 }], 0, 100, px, 0, 200)).toHaveLength(1)
    expect(rangeMarks([{ from: 100, to: 100 }], 0, 100, px, 0, 200)).toHaveLength(1)
  })
})

describe('what is dropped rather than drawn', () => {
  const px = xProject(0, 100, 0, 200)

  it('a reversed range', () => {
    expect(rangeMarks([{ from: 60, to: 40 }], 0, 100, px, 0, 200)).toEqual([])
  })

  it('non-finite endpoints', () => {
    const bad: ChartRegion[] = [
      { from: NaN, to: 50 }, { from: 10, to: NaN },
      { from: -Infinity, to: 50 }, { from: 10, to: Infinity },
    ]
    expect(rangeMarks(bad, 0, 100, px, 0, 200)).toEqual([])
  })

  it('a band wholly outside the window', () => {
    expect(rangeMarks([{ from: 200, to: 300 }], 0, 100, px, 0, 200)).toEqual([])
    expect(rangeMarks([{ from: -50, to: -10 }], 0, 100, px, 0, 200)).toEqual([])
  })

  it('a band that survives clamping as a sub-pixel hairline', () => {
    // 0.1 of a data unit over a 2px-per-unit scale = 0.2px of wash
    expect(rangeMarks([{ from: 50, to: 50.1 }], 0, 100, px, 0, 200)).toEqual([])
  })

  it('nothing at all, an empty list, or a degenerate window', () => {
    expect(rangeMarks(undefined, 0, 100, px, 0, 200)).toEqual([])
    expect(rangeMarks([], 0, 100, px, 0, 200)).toEqual([])
    expect(rangeMarks([{ from: 10, to: 20 }], 100, 100, px, 0, 200)).toEqual([])
    expect(rangeMarks([{ from: 10, to: 20 }], 100, 0, px, 0, 200)).toEqual([])
  })
})

/**
 * The constraint that keeps a structural band from destroying the panel it is
 * meant to annotate. The y-domain is computed from the SERIES, exactly as the
 * chart's geom memo does it; yRanges is not an input to that calculation, and
 * this pins both halves of the guarantee: the domain does not move, and the
 * out-of-frame band draws nothing.
 */
describe('y-ranges never influence y autoscaling', () => {
  /** The chart's own y-extent rule: min/max of the visible points, +8% padding. */
  function yDomain(values: number[]): [number, number] {
    let y0 = Math.min(...values)
    let y1 = Math.max(...values)
    if (y0 === y1) { y0 -= 1; y1 += 1 }
    const pad = (y1 - y0) * 0.08
    return [y0 - pad, y1 + pad]
  }

  it('a ±2pp stop band leaves a ±0.4pp panel at full height, and does not draw', () => {
    const signal = [-0.4, -0.1, 0.2, 0.35, 0.4]
    const [y0, y1] = yDomain(signal)
    // The domain is a function of the series alone — declaring the band cannot
    // change these numbers, because nothing downstream feeds back into them.
    expect([y0, y1]).toEqual(yDomain(signal))
    expect(y1 - y0).toBeCloseTo(0.928, 3)   // NOT blown out to ±2

    const py = yProject(y0, y1, 0, 200)
    const stopBand: ChartYRange[] = [{ from: -2, to: -0.5, label: 'structural stop', tone: 'warn' }]
    expect(rangeMarks(stopBand, y0, y1, py, 0, 200)).toEqual([])
  })

  it('a stop LINE off the top of the frame is silently absent, not clamped to the edge', () => {
    const [y0, y1] = yDomain([-0.4, 0.4])
    const py = yProject(y0, y1, 0, 200)
    // Clamping it to the frame edge would draw a stop the data never neared —
    // the honest rendering is nothing at all.
    expect(rangeMarks([{ from: 2, to: 2, label: 'stop' }], y0, y1, py, 0, 200)).toEqual([])
  })

  it('the part of a band that IS in view still draws, clipped to the domain', () => {
    const [y0, y1] = yDomain([-1, 1])
    const py = yProject(y0, y1, 0, 200)
    const marks = rangeMarks([{ from: 0.5, to: 99 }], y0, y1, py, 0, 200)
    expect(marks).toHaveLength(1)
    expect(marks[0]!.kind).toBe('band')
    // Clipped at the top of the plot, never above it
    expect(marks[0]!.pos).toBeGreaterThanOrEqual(0)
    expect(marks[0]!.pos + marks[0]!.size).toBeLessThanOrEqual(200)
  })
})
