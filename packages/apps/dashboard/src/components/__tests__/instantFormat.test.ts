import { describe, it, expect } from 'vitest'
import { formatInstant } from '../SeriesChart'

/**
 * An axis tick labels a SPAN and rounds to it; a tooltip names ONE sample.
 * Rounding the tooltip to the minute — which it did — hid which of a minute's
 * forty observations was being read, and on a settlement chart the difference
 * between :03.412 and :59.900 is the whole question.
 */

const at = (iso: string) => new Date(iso).getTime()

describe('formatInstant', () => {
  it('carries milliseconds when the sample has them', () => {
    expect(formatInstant(at('2026-08-31T16:01:03.412Z'))).toMatch(/:03\.412$/)
  })

  it('leaves them off when the sample is second-aligned', () => {
    const out = formatInstant(at('2026-08-31T16:01:03.000Z'))
    expect(out).toMatch(/:03$/)
    expect(out).not.toContain('.')
  })

  it('always names the second — a minute is not a sample', () => {
    expect(formatInstant(at('2026-08-31T16:01:59.900Z'))).toMatch(/:59\.900$/)
  })
})
