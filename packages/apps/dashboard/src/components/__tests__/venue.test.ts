import { describe, it, expect } from 'vitest'
import { pickerVenue, implVenueMap, effectiveValue } from '../venue'

/**
 * The venue a catalogue is fetched against. Getting it wrong is a 404 at
 * `/api/markets` and a picker that lists nothing, so the priority order is
 * worth pinning — especially the CEX coincidence that hid the bug: there the
 * credential type equals the venue, and every wrong derivation still passes.
 */

describe('pickerVenue', () => {
  it('takes the runtime-resolved venue over anything reconstructed', () => {
    const account = { venue: 'boros', implementation: 'pendle/boros', type: 'pendle/boros-agent' }
    expect(pickerVenue(account, { 'pendle/boros': 'something-else' })).toBe('boros')
  })

  it('falls back to the implementation pin when the gateway predates account.venue', () => {
    const account = { implementation: 'pendle/boros', type: 'pendle/boros-agent' }
    expect(pickerVenue(account, { 'pendle/boros': 'boros' })).toBe('boros')
  })

  it('falls back to the credential type last — right on a CEX, and all that is left elsewhere', () => {
    expect(pickerVenue({ implementation: 'ccxt/perp', type: 'binance' }, {})).toBe('binance')
  })

  it('never claims a venue it was not given', () => {
    expect(pickerVenue(undefined)).toBeUndefined()
    expect(pickerVenue({ implementation: 'ccxt/perp' }, {})).toBeUndefined()
  })
})

describe('implVenueMap', () => {
  it('reads the new spelling and the deprecated one', () => {
    expect(implVenueMap([
      { id: 'a', venue: 'boros' },
      { id: 'b', type: 'binance' },
      { id: 'c' },
    ])).toEqual({ a: 'boros', b: 'binance' })
  })
})

describe('effectiveValue', () => {
  const field = { name: 'venue', default: 'binance', options: [{ value: 'aster' }, { value: 'binance' }] }

  it('is what the user typed or picked', () => {
    expect(effectiveValue(field, { venue: 'hyperliquid' })).toBe('hyperliquid')
  })

  it('is the schema default while the field is untouched — what the select displays', () => {
    expect(effectiveValue(field, {})).toBe('binance')
  })

  it('is the first option when there is no default — again, what is on screen', () => {
    expect(effectiveValue({ name: 'venue', options: [{ value: 'aster' }] }, {})).toBe('aster')
  })

  it('is empty when the field holds nothing at all', () => {
    expect(effectiveValue({ name: 'symbol' }, {})).toBe('')
    expect(effectiveValue(undefined, {})).toBe('')
  })
})
