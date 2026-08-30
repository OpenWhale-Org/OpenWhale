/**
 * First-frame watchdog for venue websockets.
 *
 * A venue can advertise a stream, accept the subscription, and then deliver
 * nothing at all: Aster answers every REST call instantly while its websocket
 * sends zero frames and never errors, so the `await` never settles and there is
 * no throw to log or restart on. The key simply goes quiet for ever.
 *
 * Give the stream a warmup to prove itself. If it has not delivered by then,
 * abort it — through a child controller, so the subscription itself survives —
 * and tell the caller to fall back to REST polling for the life of this feed.
 */
export interface StreamWarmupOptions {
  /** Runs the stream; must honour the signal it is handed. */
  stream: (signal: AbortSignal) => Promise<void>
  /** Whether the stream has produced anything yet — read after it ends, and by the timer. */
  hasEmitted: () => boolean
  /** The subscription's signal; aborting it aborts the stream too. */
  signal: AbortSignal
  /** How long the stream may stay silent. Default 15s. */
  warmupMs?: number
}

export const DEFAULT_WATCH_WARMUP_MS = 15_000

/**
 * @returns true if the stream is usable (it emitted, or the caller aborted);
 *          false if it stayed silent and the caller should poll instead.
 */
export async function streamWithWarmup(options: StreamWarmupOptions): Promise<boolean> {
  const { stream, hasEmitted, signal, warmupMs = DEFAULT_WATCH_WARMUP_MS } = options
  const watch = new AbortController()
  const onOuterAbort = () => watch.abort()
  signal.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => { if (!hasEmitted()) watch.abort() }, warmupMs)
  try {
    await stream(watch.signal)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onOuterAbort)
  }
  return signal.aborted || hasEmitted()
}

/** How long a demoted key polls before the stream is given another chance. */
export const DEFAULT_POLL_WINDOW_MS = 10 * 60_000

/**
 * Run a polling loop for a bounded window, then return so the caller can retry
 * the stream.
 *
 * Demotion must not be permanent. A stream is also silent when the market is —
 * an out-of-hours stock ETF ticks a few times an hour — and a key demoted
 * during that lull would still be polling when the market opens and the stream
 * has plenty to say. `poll` is handed a signal that ends at the window, so it
 * must be a loop that watches it (the same one that already watches the
 * subscription's signal).
 */
export async function pollForWindow(
  poll: (signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
  windowMs: number = DEFAULT_POLL_WINDOW_MS,
): Promise<void> {
  const window = new AbortController()
  const onOuterAbort = () => window.abort()
  signal.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => window.abort(), windowMs)
  try {
    await poll(window.signal)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onOuterAbort)
  }
}
