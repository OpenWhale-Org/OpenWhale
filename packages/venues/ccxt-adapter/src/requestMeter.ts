import { createLogger } from '@openwhaleorg/core'

/**
 * What this process actually asks of a venue, per minute.
 *
 * Rate-limit failures name the unlucky caller, not the expensive one: a 429
 * lands on whichever request happened to be in flight when the budget ran out,
 * so the stack traces point at position reads that cost 2 while something else
 * spends 20 a call somewhere quieter. Twice in one day that sent this
 * investigation after the wrong consumer.
 *
 * ccxt computes the venue's own weight for every request before sending it —
 * `calculateRateLimiterCost` — and every REST call passes through `fetch2`.
 * Counting there, by endpoint AND by the venue-specific `type` field that
 * distinguishes a weight-2 `l2Book` from a weight-20 `userFills`, answers the
 * only question that matters: where is the budget going.
 *
 * Measurement only. It changes no pacing and blocks nothing — an order must
 * never wait on bookkeeping.
 */

const log = createLogger('VenueRequests')

/** How often the tally is reported. One line per venue per window. */
const WINDOW_MS = 60_000

interface Tally { calls: number; weight: number }

const byVenue = new Map<string, Map<string, Tally>>()
let timer: ReturnType<typeof setInterval> | null = null

/** `info:clearinghouseState`, `exchange:order`, `GET /fapi/v3/positionRisk`… */
function endpointKey(path: string, method: string, params: Record<string, unknown>): string {
  const type = params?.['type']
  return typeof type === 'string' ? `${path}:${type}` : `${method} ${path}`
}

function report(): void {
  for (const [venue, tallies] of byVenue) {
    const rows = [...tallies].sort((a, b) => b[1].weight - a[1].weight)
    const weight = rows.reduce((n, [, t]) => n + t.weight, 0)
    const calls = rows.reduce((n, [, t]) => n + t.calls, 0)
    if (calls === 0) continue
    log.info({
      venue,
      calls,
      weight,
      top: rows.slice(0, 8).map(([k, t]) => `${k} ×${t.calls}=${t.weight}`),
    }, 'Venue REST usage this minute')
  }
  byVenue.clear()
}

/**
 * Count every REST request this exchange makes. Returns the exchange.
 *
 * Wraps `fetch2` rather than `throttle` because only `fetch2` sees which
 * endpoint is being called; the throttle sees a number.
 */
export function meterRequests<T extends {
  id: string
  fetch2: (path: string, api?: string, method?: string, params?: Record<string, unknown>, headers?: unknown, body?: unknown, config?: unknown) => Promise<unknown>
  calculateRateLimiterCost: (api: string, method: string, path: string, params: Record<string, unknown>, config: unknown) => number
}>(exchange: T): T {
  if (process.env['OPENWHALE_VENUE_METER'] === 'off') return exchange
  const original = exchange.fetch2.bind(exchange)
  exchange.fetch2 = (path, api = 'public', method = 'GET', params = {}, headers?, body?, config = {}) => {
    try {
      const venue = exchange.id
      const tallies = byVenue.get(venue) ?? new Map<string, Tally>()
      byVenue.set(venue, tallies)
      const key = endpointKey(path, method, params)
      const row = tallies.get(key) ?? { calls: 0, weight: 0 }
      row.calls += 1
      // The venue's own weight, as ccxt computes it for its rate limiter.
      row.weight += Number(exchange.calculateRateLimiterCost(api, method, path, params, config)) || 0
      tallies.set(key, row)
    } catch { /* accounting must never break a request */ }
    return original(path, api, method, params, headers, body, config)
  }
  if (!timer) {
    timer = setInterval(report, WINDOW_MS)
    timer.unref?.()
  }
  return exchange
}

/** The current window's tallies, for a status endpoint. */
export function venueRequestUsage(): Array<{ venue: string; calls: number; weight: number; endpoints: Array<{ endpoint: string; calls: number; weight: number }> }> {
  return [...byVenue].map(([venue, tallies]) => {
    const endpoints = [...tallies]
      .map(([endpoint, t]) => ({ endpoint, calls: t.calls, weight: t.weight }))
      .sort((a, b) => b.weight - a.weight)
    return {
      venue,
      calls: endpoints.reduce((n, e) => n + e.calls, 0),
      weight: endpoints.reduce((n, e) => n + e.weight, 0),
      endpoints,
    }
  })
}
