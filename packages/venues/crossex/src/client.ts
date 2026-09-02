import { createHash, createHmac } from 'crypto'
import { RetryableAdapterError, TerminalAdapterError } from '@openwhaleorg/core'

/**
 * Gate APIv4 transport for the CrossEx endpoints.
 *
 * Hand-rolled rather than ccxt: ccxt 4.5.52 has no CrossEx at all (`gate.js`
 * does not contain the string), and CrossEx is not gate's futures API under a
 * different path — it is its own account model, symbol vocabulary and order
 * shape. There is no testnet; every request here reaches production.
 */

export const CROSSEX_REST_BASE = 'https://api.gateio.ws'
export const CROSSEX_PATH_PREFIX = '/api/v4'

/** Public market feeds, for the WebSocket work that follows. */
export const CROSSEX_WS_PUBLIC = 'wss://api.gateio.ws/ws/crossex/public'
/** Order/position/asset pushes after an authenticated login. */
export const CROSSEX_WS_PRIVATE = 'wss://api.gateio.ws/ws/crossex'

export interface CrossExClientOptions {
  /** Gate APIv4 key. Omit for the public endpoints (symbols, tickers, funding). */
  apiKey?: string
  apiSecret?: string
  /** Override for tests. */
  baseUrl?: string
  fetchImpl?: typeof fetch
  /** Broker/affiliate channel, sent as X-Gate-Channel-Id on order placement. */
  channelId?: string
  /** Per-request timeout. */
  timeoutMs?: number
}

type Query = Record<string, string | number | boolean | undefined>

export class CrossExClient {
  private readonly apiKey: string | undefined
  private readonly apiSecret: string | undefined
  private readonly baseUrl: string
  private readonly doFetch: typeof fetch
  private readonly channelId: string | undefined
  private readonly timeoutMs: number

  constructor(options: CrossExClientOptions = {}) {
    this.apiKey = options.apiKey
    this.apiSecret = options.apiSecret
    this.baseUrl = options.baseUrl ?? CROSSEX_REST_BASE
    this.doFetch = options.fetchImpl ?? fetch
    this.channelId = options.channelId
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  get authenticated(): boolean {
    return Boolean(this.apiKey && this.apiSecret)
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, query ? { query } : {})
  }

  /** GET that must be signed — CrossEx serves account reads only to a key. */
  getPrivate<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { ...(query ? { query } : {}), signed: true })
  }

  post<T>(path: string, body?: unknown, options?: { order?: boolean }): Promise<T> {
    return this.request<T>('POST', path, { body, signed: true, ...(options?.order ? { order: true } : {}) })
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body, signed: true })
  }

  delete<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('DELETE', path, { ...(query ? { query } : {}), signed: true })
  }

  private async request<T>(
    method: string,
    path: string,
    options: { query?: Query; body?: unknown; signed?: boolean; order?: boolean } = {},
  ): Promise<T> {
    const query = serializeQuery(options.query)
    const fullPath = `${CROSSEX_PATH_PREFIX}${path}`
    const url = `${this.baseUrl}${fullPath}${query ? `?${query}` : ''}`
    const bodyText = options.body === undefined ? '' : JSON.stringify(options.body)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (bodyText) headers['Content-Type'] = 'application/json'
    if (options.signed) {
      if (!this.apiKey || !this.apiSecret) {
        throw new TerminalAdapterError('CrossEx: this call needs an API key — the account was created without credentials.')
      }
      // Gate APIv4: SIGN = HMAC-SHA512 over
      //   METHOD \n PATH \n QUERY \n SHA512(body) \n TIMESTAMP(seconds)
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const hashedBody = createHash('sha512').update(bodyText).digest('hex')
      const payload = [method, fullPath, query, hashedBody, timestamp].join('\n')
      headers['KEY'] = this.apiKey
      headers['SIGN'] = createHmac('sha512', this.apiSecret).update(payload).digest('hex')
      headers['Timestamp'] = timestamp
    }
    // Only order placement carries the broker channel, matching what the venue
    // attributes; adding it to reads would claim volume that is not a trade.
    if (options.order && this.channelId) headers['X-Gate-Channel-Id'] = this.channelId

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.doFetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(bodyText ? { body: bodyText } : {}),
      })
    } catch (err) {
      // Network-shaped: a timeout or a reset says nothing about the request
      // being wrong, so it stays retryable.
      throw new RetryableAdapterError(`CrossEx ${method} ${path} failed: ${(err as Error).message}`, { cause: err })
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text()
    if (!response.ok) throw errorFor(response.status, method, path, text)
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch (err) {
      throw new RetryableAdapterError(`CrossEx ${method} ${path}: unreadable response`, { cause: err })
    }
  }
}

/**
 * HTTP status → the retry taxonomy.
 *
 * The venue's own label is kept in the message: `BALANCE_NOT_ENOUGH` and
 * `INVALID_PARAM` are both 400s, and an operator reading a failed execution
 * needs the one the venue actually said.
 */
function errorFor(status: number, method: string, path: string, body: string): Error {
  const label = labelOf(body)
  const detail = label ? `${label} — ${body.slice(0, 300)}` : body.slice(0, 300)
  const message = `CrossEx ${method} ${path} → ${status}: ${detail}`
  // 429 and 5xx are the venue asking to be asked again; everything else in the
  // 4xx range is this request being wrong, and will be wrong again.
  if (status === 429 || status >= 500) return new RetryableAdapterError(message)
  return new TerminalAdapterError(message)
}

function labelOf(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { label?: string; message?: string }
    return parsed.label
  } catch {
    return undefined
  }
}

/** Sorted, unencoded pairs — the exact string that must also be signed. */
function serializeQuery(query: Query | undefined): string {
  if (!query) return ''
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== '')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join('&')
}
