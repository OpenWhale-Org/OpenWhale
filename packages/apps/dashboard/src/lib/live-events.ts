'use client'

/**
 * Shared SSE connection to /api/events.
 *
 * Browsers cap HTTP/1.1 connections per origin (~6); one EventSource per
 * expanded instance card plus the monitor page starves the pool and each
 * server-side connection registers its own handler set. All subscribers
 * share a single connection with client-side fan-out instead.
 */

type EventListener = (data: unknown) => void
type StatusListener = (connected: boolean) => void

let source: EventSource | null = null
let connected = false
const eventListeners = new Set<EventListener>()
const statusListeners = new Set<StatusListener>()

function ensureSource(): void {
  if (source) return
  source = new EventSource('/api/events')
  source.onopen = () => {
    connected = true
    for (const l of statusListeners) l(true)
  }
  source.onerror = () => {
    connected = false
    for (const l of statusListeners) l(false)
    // A closed (not merely erroring) stream after the gateway rejected the
    // session means the cookie expired. EventSource cannot read the status
    // code, so confirm with a cheap authenticated call before bouncing the
    // user — a gateway restart must not look like a logout.
    if (source?.readyState === EventSource.CLOSED) void bounceIfSignedOut()
  }
  source.onmessage = (e: MessageEvent<string>) => {
    let data: unknown
    try {
      data = JSON.parse(e.data)
    } catch {
      return
    }
    for (const l of eventListeners) l(data)
  }
}

/**
 * Send the user to the login page only when the gateway actually rejects us.
 * An unreachable gateway leaves them where they are — losing the page they
 * were reading because a backend blipped is worse than a stale view.
 */
async function bounceIfSignedOut(): Promise<void> {
  try {
    const res = await fetch('/api/auth/me')
    if (res.status === 401) window.location.href = '/login'
  } catch { /* gateway unreachable — not a signed-out state */ }
}

/** Subscribe to live events. Returns an unsubscribe function. */
export function subscribeLiveEvents(onEvent: EventListener, onStatus?: StatusListener): () => void {
  eventListeners.add(onEvent)
  if (onStatus) {
    statusListeners.add(onStatus)
    onStatus(connected)
  }
  ensureSource()
  return () => {
    eventListeners.delete(onEvent)
    if (onStatus) statusListeners.delete(onStatus)
    if (eventListeners.size === 0 && statusListeners.size === 0) {
      source?.close()
      source = null
      connected = false
    }
  }
}
