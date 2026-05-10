import { createLogger } from '../utils/logger.js'

export interface HttpRequestOptions {
  headers?: Record<string, string>
  /** Request timeout in ms (default: 30000). */
  timeout?: number
}

export interface HttpResponse<T = unknown> {
  status: number
  headers: Record<string, string>
  data: T
}

/**
 * Controlled HTTP client injected into Strategy as `this.http`.
 *
 * All requests are logged for observability. Strategies must use this client
 * instead of calling fetch/axios directly — this keeps HTTP traffic auditable
 * and allows the framework to enforce policies (rate limits, allowlists, etc.)
 * in the future.
 */
export class HttpClient {
  private readonly strategyId: string
  private get log() { return createLogger(`${this.strategyId}:http`) }

  constructor(strategyId: string) {
    this.strategyId = strategyId
  }

  async get<T = unknown>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('GET', url, undefined, options)
  }

  async post<T = unknown>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('POST', url, body, options)
  }

  async put<T = unknown>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', url, body, options)
  }

  async patch<T = unknown>(url: string, body?: unknown, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('PATCH', url, body, options)
  }

  async delete<T = unknown>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', url, undefined, options)
  }

  async request<T = unknown>(
    method: string,
    url: string,
    body?: unknown,
    options?: HttpRequestOptions,
  ): Promise<HttpResponse<T>> {
    const timeout = options?.timeout ?? 30_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    this.log.debug({ method, url }, 'HTTP request')

    let response: Response
    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
    } catch (err) {
      this.log.error({ method, url, err }, 'HTTP request failed')
      throw err
    } finally {
      clearTimeout(timer)
    }

    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => { responseHeaders[key] = value })

    let data: T
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      data = await response.json() as T
    } else {
      data = await response.text() as unknown as T
    }

    this.log.debug({ method, url, status: response.status }, 'HTTP response')

    if (!response.ok) {
      throw new HttpError(response.status, method, url, data)
    }

    return { status: response.status, headers: responseHeaders, data }
  }
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly url: string,
    readonly body: unknown,
  ) {
    super(`HTTP ${status} ${method} ${url}`)
    this.name = 'HttpError'
  }
}
