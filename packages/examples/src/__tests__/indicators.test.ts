import { describe, it, expect } from 'vitest'
import { sma, stdev, zScore, donchian, atr, signedExposure, sizeAgainstCap } from '../indicators.js'

describe('sma / stdev / zScore', () => {
  it('averages the LAST period values, not the whole series', () => {
    expect(sma([1, 2, 3, 100, 200], 2)).toBe(150)
  })

  it('is undefined when the series is shorter than the period', () => {
    expect(sma([1, 2], 3)).toBeUndefined()
    expect(stdev([1, 2], 3)).toBeUndefined()
    expect(zScore([1, 2], 3)).toBeUndefined()
  })

  it('measures deviation in standard-deviation units', () => {
    // mean 2, population sd 1 → last value 4 sits 2 sd above
    expect(zScore([1, 2, 3, 4], 3)).toBeCloseTo(1.2247, 3)
    expect(stdev([1, 2, 3], 3)).toBeCloseTo(0.8165, 3)
  })

  it('refuses a z-score on a flat series instead of returning Infinity', () => {
    expect(zScore([5, 5, 5, 5], 4)).toBeUndefined()
  })
})

describe('donchian', () => {
  const highs = [10, 12, 11, 13, 20]
  const lows = [8, 9, 7, 10, 19]

  it('excludes the current bar so a breakout is a real breakout', () => {
    // period 4 over bars 0..3 — the 20/19 bar is the one being tested
    expect(donchian(highs, lows, 4)).toEqual({ upper: 13, lower: 7 })
  })

  it('needs period+1 bars', () => {
    expect(donchian(highs, lows, 5)).toBeUndefined()
  })
})

describe('atr', () => {
  it('averages true range, accounting for gaps', () => {
    const highs = [10, 11, 12]
    const lows = [9, 10, 11]
    const closes = [9.5, 10.5, 11.5]
    // bars 1..2: TR = max(h-l, |h-prevClose|, |l-prevClose|) = 1.5 each
    expect(atr(highs, lows, closes, 2)).toBeCloseTo(1.5, 6)
  })

  it('is undefined without a prior bar to gap from', () => {
    expect(atr([10], [9], [9.5], 1)).toBeUndefined()
  })
})

describe('signedExposure', () => {
  const positions = [
    { id: 'BTC/USDT:USDT', side: 'long', value: 1000 },
    { id: 'ETH/USDT:USDT', side: 'short', value: 500 },
  ]

  it('signs by side and returns 0 for symbols not held', () => {
    expect(signedExposure(positions, 'BTC/USDT:USDT')).toBe(1000)
    expect(signedExposure(positions, 'ETH/USDT:USDT')).toBe(-500)
    expect(signedExposure(positions, 'SOL/USDT:USDT')).toBe(0)
  })

  it('normalizes a venue that reports a short with a negative value', () => {
    expect(signedExposure([{ id: 'X', side: 'short', value: -500 }], 'X')).toBe(-500)
  })
})

describe('sizeAgainstCap', () => {
  it('allows only the headroom left under the cap', () => {
    expect(sizeAgainstCap(500, 800, 1, 1000)).toEqual({ allowedUsd: 200, reduceOnly: false })
  })

  it('returns nothing once the cap is reached', () => {
    expect(sizeAgainstCap(500, 1000, 1, 1000)).toEqual({ allowedUsd: 0, reduceOnly: false })
  })

  it('treats an opposing order as a reduction capped at the exposure — never a flip', () => {
    expect(sizeAgainstCap(5000, 800, -1, 1000)).toEqual({ allowedUsd: 800, reduceOnly: true })
    expect(sizeAgainstCap(5000, -800, 1, 1000)).toEqual({ allowedUsd: 800, reduceOnly: true })
  })

  it('opens freely from flat, up to the cap', () => {
    expect(sizeAgainstCap(400, 0, -1, 1000)).toEqual({ allowedUsd: 400, reduceOnly: false })
    expect(sizeAgainstCap(4000, 0, -1, 1000)).toEqual({ allowedUsd: 1000, reduceOnly: false })
  })
})
