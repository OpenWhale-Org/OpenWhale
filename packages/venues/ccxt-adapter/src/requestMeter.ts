import dc from 'node:diagnostics_channel'
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

/**
 * Name the caller of a market-map reload.
 *
 * `loadMarkets` on Hyperliquid is not one request: it walks every HIP-3 dex at
 * weight 20 apiece, ~220 in total, and `perpDexs` is its fingerprint. Something
 * triggers it several times a minute, which no tally can identify — only the
 * stack can. Sampled, so the diagnosis cannot itself become the problem.
 */
const RELOAD_FINGERPRINTS = new Set(['info:perpDexs'])
let tracedAt = 0
function traceIfExpensive(venue: string, key: string): void {
  if (!RELOAD_FINGERPRINTS.has(key)) return
  const now = Date.now()
  if (now - tracedAt < 20_000) return
  tracedAt = now
  const stack = (new Error().stack ?? '').split('\n').slice(2, 16).map(l => l.trim())
  log.warn({ venue, endpoint: key, stack }, 'Market map reload — each one costs a HIP-3 fan-out')
}

/** One minute of one venue's requests, as handed to listeners. */
export interface VenueMinute {
  venue: string
  calls: number
  weight: number
  /** Heaviest endpoints first: `info:metaAndAssetCtxs ×11=220`. */
  top: string[]
}

const listeners = new Set<(minute: VenueMinute) => void>()

/**
 * The last few seconds of requests, so a 429 can be read next to what
 * preceded it. A rejection alone says "too many"; only the timeline says
 * how many, of what, and from where — which is the whole question when the
 * per-minute tally sits far under the venue's budget and the venue still
 * says no.
 */
const RECENT_MAX = 400
const RECENT_WINDOW_MS = 5_000
const recent: Array<{ t: number; venue: string; key: string }> = []
function remember(venue: string, key: string): void {
  recent.push({ t: Date.now(), venue, key })
  if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX)
}
function recentFor(venue: string, now: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of recent) {
    if (r.venue !== venue || now - r.t > RECENT_WINDOW_MS) continue
    out[r.key] = (out[r.key] ?? 0) + 1
  }
  return out
}

/**
 * Every HTTPS request this process makes, by host — the wire, not ccxt.
 *
 * The tally above counts what goes through `fetch2`; a raw `fetch` to a
 * venue, from a monitor or a script, is invisible to it and to the budget
 * alert built on it. undici publishes each request it creates, so the wire
 * count is one subscription away, and the gap between the two columns is the
 * unmetered caller.
 */
const wireByHost = new Map<string, number>()
let wireTapped = false
function tapWire(): void {
  if (wireTapped) return
  wireTapped = true
  try {
    dc.subscribe('undici:request:create', (message) => {
      const req = (message as { request?: { origin?: string } }).request
      const host = req?.origin ?? 'unknown'
      wireByHost.set(host, (wireByHost.get(host) ?? 0) + 1)
    })
  } catch { /* no undici channel on this runtime */ }
}

/**
 * Hear every venue's minute as it closes. The alerting side lives here: the
 * meter knows the spend, the gateway knows the venue's budget and who to tell.
 */
export function onVenueMinute(listener: (minute: VenueMinute) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function report(): void {
  for (const [venue, tallies] of byVenue) {
    const rows = [...tallies].sort((a, b) => b[1].weight - a[1].weight)
    const weight = rows.reduce((n, [, t]) => n + t.weight, 0)
    const calls = rows.reduce((n, [, t]) => n + t.calls, 0)
    if (calls === 0) continue
    const minute: VenueMinute = {
      venue, calls, weight,
      top: rows.slice(0, 8).map(([k, t]) => `${k} ×${t.calls}=${t.weight}`),
    }
    log.info(minute, 'Venue REST usage this minute')
    for (const listener of listeners) {
      try { listener(minute) } catch { /* a listener's fault is not the meter's */ }
    }
  }
  byVenue.clear()
  if (wireByHost.size > 0) {
    log.info({ hosts: Object.fromEntries(wireByHost) }, 'Raw fetch() requests this minute, by host')
    wireByHost.clear()
  }
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
      remember(venue, key)
      traceIfExpensive(venue, key)
    } catch { /* accounting must never break a request */ }
    return original(path, api, method, params, headers, body, config)
  }
  // ccxt's own response hook: sees status, headers and body before any error
  // is raised. A 429 is logged with the request that drew it and the last
  // five seconds of this venue's traffic.
  const ex = exchange as unknown as {
    onRestResponse?: (...args: unknown[]) => unknown
    walletAddress?: string
  }
  const onRestResponse = ex.onRestResponse?.bind(exchange)
  if (onRestResponse) {
    ex.onRestResponse = (...args: unknown[]) => {
      try {
        const [status, , url, , responseHeaders, responseBody, , requestBody] = args as [number, string, string, string, Record<string, string>, string, unknown, string]
        if (status === 429) {
          const now = Date.now()
          log.warn({
            venue: exchange.id, url,
            request: String(requestBody ?? '').slice(0, 200),
            responseHeaders,
            responseBody: String(responseBody ?? '').slice(0, 300),
            account: ex.walletAddress ? `${ex.walletAddress.slice(0, 6)}…${ex.walletAddress.slice(-4)}` : undefined,
            last5s: recentFor(exchange.id, now),
          }, 'Venue answered 429')
        }
      } catch { /* diagnostics must never break a response */ }
      return onRestResponse(...args)
    }
  }
  tapWire()
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
