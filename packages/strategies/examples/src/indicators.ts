/**
 * Pure indicator helpers shared by the example strategies.
 *
 * Deliberately dependency-free and side-effect-free: every function takes an
 * array of numbers (oldest first) and returns a number or undefined when the
 * series is too short. Strategies stay readable, and the maths is unit-tested
 * in isolation.
 */

/** Simple moving average of the LAST `period` values. undefined if too short. */
export function sma(values: readonly number[], period: number): number | undefined {
  if (period <= 0 || values.length < period) return undefined
  let sum = 0
  for (let i = values.length - period; i < values.length; i++) sum += values[i]!
  return sum / period
}

/** Population standard deviation of the LAST `period` values. */
export function stdev(values: readonly number[], period: number): number | undefined {
  const mean = sma(values, period)
  if (mean === undefined) return undefined
  let acc = 0
  for (let i = values.length - period; i < values.length; i++) {
    const d = values[i]! - mean
    acc += d * d
  }
  return Math.sqrt(acc / period)
}

/**
 * How many standard deviations the latest value sits from its own mean.
 * undefined when the series is too short or flat (zero deviation — a z-score
 * would be infinite, and "no variance" is not a trading signal).
 */
export function zScore(values: readonly number[], period: number): number | undefined {
  const mean = sma(values, period)
  const sd = stdev(values, period)
  if (mean === undefined || sd === undefined || sd <= 0) return undefined
  return (values[values.length - 1]! - mean) / sd
}

/**
 * Donchian channel over the `period` values ENDING BEFORE the last one — the
 * breakout reference. Excluding the latest bar is what makes "close above the
 * channel" a breakout rather than a tautology (the bar's own high always
 * touches the channel that contains it).
 */
export function donchian(
  highs: readonly number[],
  lows: readonly number[],
  period: number,
): { upper: number; lower: number } | undefined {
  if (period <= 0 || highs.length < period + 1 || lows.length < period + 1) return undefined
  const end = highs.length - 1                  // exclusive: skips the current bar
  let upper = -Infinity
  let lower = Infinity
  for (let i = end - period; i < end; i++) {
    if (highs[i]! > upper) upper = highs[i]!
    if (lows[i]! < lower) lower = lows[i]!
  }
  return { upper, lower }
}

/**
 * Average true range over the last `period` bars — a volatility unit for
 * sizing stops in price terms. Needs period+1 bars (true range looks back one).
 */
export function atr(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period: number,
): number | undefined {
  if (period <= 0 || closes.length < period + 1) return undefined
  const trs: number[] = []
  for (let i = closes.length - period; i < closes.length; i++) {
    const prevClose = closes[i - 1]!
    trs.push(Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - prevClose),
      Math.abs(lows[i]! - prevClose),
    ))
  }
  return trs.reduce((s, v) => s + v, 0) / trs.length
}

/**
 * Signed USD exposure for one symbol out of an account's position list:
 * positive = long, negative = short, 0 = flat. Every example strategy caps
 * risk against this rather than trusting its own idea of what it opened —
 * positions are the venue's truth, including fills the strategy never made.
 */
export function signedExposure(
  positions: ReadonlyArray<{ id: string; side: string; value: number }>,
  symbol: string,
): number {
  const p = positions.find(x => x.id === symbol)
  if (!p) return 0
  return p.side === 'short' ? -Math.abs(p.value) : Math.abs(p.value)
}

/**
 * How much notional a new order may add in `direction` (+1 long / −1 short)
 * without breaching `maxPositionUsd`, and whether it is a reduction.
 *
 * A reduction never opens the other side: it is capped at the existing
 * exposure, so mirroring/exiting can flatten but never flip through zero.
 */
export function sizeAgainstCap(
  wantedUsd: number,
  exposureUsd: number,
  direction: 1 | -1,
  maxPositionUsd: number,
): { allowedUsd: number; reduceOnly: boolean } {
  const isReducing = exposureUsd !== 0 && Math.sign(exposureUsd) !== direction
  if (isReducing) {
    return { allowedUsd: Math.min(wantedUsd, Math.abs(exposureUsd)), reduceOnly: true }
  }
  const headroom = Math.max(0, maxPositionUsd - Math.abs(exposureUsd))
  return { allowedUsd: Math.min(wantedUsd, headroom), reduceOnly: false }
}
