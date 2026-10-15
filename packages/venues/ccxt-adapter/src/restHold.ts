import { RetryableAdapterError, createLogger } from '@openwhaleorg/core'

/**
 * A venue that has said "stop" is not asked again until the time it named.
 *
 * Binance counts request weight per IP per minute. Over the budget it answers
 * 429 with a Retry-After; keep sending through the 429 and it answers 418 —
 * the IP is banned, the body says until when, and every request that still
 * arrives during the ban extends it. ccxt's rate limiter paces one exchange
 * object; this process holds dozens on the same IP, and the ETF engine on the
 * same box holds more, so the limiter never sees the whole picture.
 *
 * 2026-10-14 12:30 UTC, and again 2026-10-15 12:30 UTC: the engine's burst at
 * the US macro print drew the first 418 (two minutes). What turned two minutes
 * into forty-four, and the next day into sixty-six, was this process: monitor
 * feeds restarting every thirty seconds, a fills sweep of six hundred calls,
 * each one an answer the venue had already given. Nothing here caused the ban;
 * everything here prolonged it.
 *
 * So: the venue's own 418/429 answer sets a hold on that venue id, and until
 * it passes every REST call fails locally, before ccxt's throttle, without a
 * packet. Callers see a retryable error that names the time. WebSocket
 * traffic is untouched — it is not what the ban measures.
 */

const log = createLogger('VenueHold')

/** Added to what the venue said, for clock skew and the venue's own rounding. */
const MARGIN_MS = 1_000
/** A 429 without Retry-After: the weight window is a minute; wait out this one. */
const DEFAULT_429_HOLD_MS = 60_000
/** Never hold longer than this on one answer, whatever the body claims. */
const MAX_HOLD_MS = 2 * 3600_000

interface Hold { until: number; reason: string; refused: number }

const holds = new Map<string, Hold>()

export class VenueHeldError extends RetryableAdapterError {
  constructor(readonly venue: string, readonly heldUntil: number, reason: string) {
    super(`${venue} REST held until ${new Date(heldUntil).toISOString()} — ${reason}`)
  }
}

/** When this venue's REST is held until, if it is. */
export function restHeldUntil(venue: string): number | undefined {
  const hold = holds.get(venue)
  if (!hold) return undefined
  if (hold.until <= Date.now()) {
    holds.delete(venue)
    return undefined
  }
  return hold.until
}

/** Hold a venue's REST until `until`. A later time extends; an earlier one is ignored. */
export function holdRest(venue: string, until: number, reason: string): void {
  const now = Date.now()
  const capped = Math.min(until + MARGIN_MS, now + MAX_HOLD_MS)
  const current = holds.get(venue)
  if (current && current.until >= capped) return
  holds.set(venue, { until: capped, reason, refused: current?.refused ?? 0 })
  log.warn({ venue, until: new Date(capped).toISOString(), holdMs: capped - now, reason }, 'Venue REST held — the venue said stop; calls fail locally until then')
}

/** Forget every hold. Tests. */
export function resetRestHolds(): void {
  holds.clear()
}

/**
 * What the venue's answer says about when to come back.
 *
 * Binance's ban body: `{"code":-1003,"msg":"... banned until 1791983690384 ..."}`,
 * an epoch in ms. Both 418 and 429 carry Retry-After in seconds. The body is
 * trusted over the header for a ban because the header rounds.
 *
 * A 429 that names no time is held only on Binance, whose weight window is a
 * minute and whose next step is the ban. Elsewhere — Hyperliquid prices a
 * 429 per address as well as per IP, and says nothing about when — a bare
 * 429 stays what it was: one failed call, not a minute without orders.
 */
export function holdFromResponse(venue: string, status: number, headers: Record<string, string> | undefined, body: string, now = Date.now()): { until: number; reason: string } | undefined {
  if (status !== 418 && status !== 429) return undefined
  const banned = /banned until (\d{13})/.exec(body)
  if (banned) return { until: Number(banned[1]), reason: `${status} IP banned` }
  const retryAfter = headerOf(headers, 'retry-after')
  const seconds = retryAfter !== undefined ? Number(retryAfter) : NaN
  if (Number.isFinite(seconds) && seconds > 0) return { until: now + seconds * 1000, reason: `${status} Retry-After ${seconds}s` }
  if (status === 429 && !venue.startsWith('binance')) return undefined
  return { until: now + DEFAULT_429_HOLD_MS, reason: `${status} without Retry-After` }
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v
  return undefined
}

/**
 * Put the hold in front of every REST request this exchange makes, and learn
 * holds from every answer it gets. Returns the exchange.
 *
 * `fetch2` is where ccxt pays the throttle and signs; failing before it means
 * no wait and no packet. `onRestResponse` sees the status, headers and body
 * before ccxt turns them into an exception.
 */
export function gateRequests<T extends {
  id: string
  fetch2: (path: string, api?: string, method?: string, params?: Record<string, unknown>, headers?: unknown, body?: unknown, config?: unknown) => Promise<unknown>
}>(exchange: T): T {
  if (process.env['OPENWHALE_VENUE_HOLD'] === 'off') return exchange
  const original = exchange.fetch2.bind(exchange)
  exchange.fetch2 = (path, api = 'public', method = 'GET', params = {}, headers?, body?, config = {}) => {
    const hold = holds.get(exchange.id)
    if (hold && hold.until > Date.now()) {
      hold.refused += 1
      if (hold.refused === 1 || hold.refused % 100 === 0) {
        log.info({ venue: exchange.id, path, refused: hold.refused, until: new Date(hold.until).toISOString() }, 'REST call refused locally — venue is held')
      }
      return Promise.reject(new VenueHeldError(exchange.id, hold.until, hold.reason))
    }
    return original(path, api, method, params, headers, body, config)
  }
  const ex = exchange as unknown as { onRestResponse?: (...args: unknown[]) => unknown }
  const onRestResponse = ex.onRestResponse?.bind(exchange)
  if (onRestResponse) {
    ex.onRestResponse = (...args: unknown[]) => {
      try {
        const [status, , , , responseHeaders, responseBody] = args as [number, string, string, string, Record<string, string>, string]
        const hold = holdFromResponse(exchange.id, status, responseHeaders, String(responseBody ?? ''))
        if (hold) holdRest(exchange.id, hold.until, hold.reason)
      } catch { /* learning a hold must never break a response */ }
      return onRestResponse(...args)
    }
  }
  return exchange
}
