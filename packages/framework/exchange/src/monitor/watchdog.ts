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
 *
 * Proving itself once is not enough. A stream can speak for hours and then
 * stop, with the same signature: no error, no close, an await that never
 * settles. Measured 2026-09-13 on the live board — binance SNXX/SNDK went
 * quiet at 14:14 and SOXS/SOXL at 14:47 while twelve other keys on the same
 * process kept writing; the charts stayed up showing the last thing each had
 * seen, which is the worst way for a feed to fail. So there is a second
 * watchdog for the rest of the stream's life: see `idleMs`.
 */
export interface StreamWarmupOptions {
  /** Runs the stream; must honour the signal it is handed. */
  stream: (signal: AbortSignal) => Promise<void>
  /** Whether the stream has produced anything yet — read after it ends, and by the timer. */
  hasEmitted: () => boolean
  /** The subscription's signal; aborting it aborts the stream too. */
  signal: AbortSignal
  /** How long the stream may stay silent before its FIRST frame. Default 15s. */
  warmupMs?: number
  /**
   * How long the stream may stay silent AFTER it has been speaking, before it
   * is treated as hung and aborted so the caller can reconnect. Off when
   * absent — but a caller that can tolerate a reconnect should set it, because
   * the failure it catches is invisible by construction.
   *
   * Needs `lastFrameAt`; without it there is nothing to measure.
   */
  idleMs?: number
  /** When the last frame arrived, in ms. Only read when `idleMs` is set. */
  lastFrameAt?: () => number
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
  /* The idle check samples rather than arming a timer per frame: a busy book
     is thousands of frames a minute, and re-arming a timer on each one is
     work the hot path should not do to catch a fault measured in minutes. */
  const { idleMs, lastFrameAt } = options
  const idle = idleMs !== undefined && idleMs > 0 && lastFrameAt !== undefined
    ? setInterval(() => {
      if (hasEmitted() && Date.now() - lastFrameAt() > idleMs) watch.abort()
    }, Math.max(1_000, Math.floor(idleMs / 4)))
    : undefined
  try {
    await stream(watch.signal)
  } finally {
    clearTimeout(timer)
    if (idle !== undefined) clearInterval(idle)
    signal.removeEventListener('abort', onOuterAbort)
    /*
     * Whatever the stream started dies with the call. A two-leg stream is a
     * Promise.all of two watchers: when one rejects, the other is still
     * running, still holding the caller's callbacks and the caller's stale
     * state — and the caller, seeing a rejection, starts a fresh pair. Two
     * emitters for one key, one of them frozen at the last price it saw.
     * Measured 2026-09-03 on binance SNXX/SNDK: every record arrived twice,
     * two milliseconds apart, the A leg alternating between a live price and
     * a dead one while B matched exactly. The deviation swung ±0.3% every two
     * seconds and the z-score ±2σ with it, on a pair that was not moving.
     */
    watch.abort()
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
