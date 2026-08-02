import { defineCcxtVenue } from './defineCcxtVenue.js'
import { VENUE_SPECS } from './venues.js'

export { defineCcxtVenue, buildVenueAdapter, venueKinds } from './defineCcxtVenue.js'
export type { CcxtVenueSpec, CredentialStyle } from './defineCcxtVenue.js'
export { VENUE_SPECS } from './venues.js'

type VenuePlugin = ReturnType<typeof defineCcxtVenue>

/** Every roster venue, lowered into a plugin manifest, keyed by venue name. */
export const venuePlugins: Record<string, VenuePlugin> = Object.fromEntries(
  VENUE_SPECS.map(spec => [spec.name, defineCcxtVenue(spec)]),
)

/** Load order does not matter — venue cells are independent squares. */
export const allVenuePlugins: VenuePlugin[] = VENUE_SPECS.map(spec => venuePlugins[spec.name]!)

// Named exports so a host can load exactly the venues it wants.
export const bybitPlugin = venuePlugins['bybit']!
export const okxPlugin = venuePlugins['okx']!
export const bitgetPlugin = venuePlugins['bitget']!
export const gatePlugin = venuePlugins['gate']!
export const krakenPlugin = venuePlugins['kraken']!
export const krakenFuturesPlugin = venuePlugins['kraken-futures']!
export const upbitPlugin = venuePlugins['upbit']!
export const lighterPlugin = venuePlugins['lighter']!
export const mexcPlugin = venuePlugins['mexc']!
export const kucoinPlugin = venuePlugins['kucoin']!
export const kucoinFuturesPlugin = venuePlugins['kucoin-futures']!
export const bingxPlugin = venuePlugins['bingx']!

/** Package default: the whole roster (the gateway loads this). */
export default allVenuePlugins
