/**
 * Says when this process stopped answering, and for how long.
 *
 * The gateway is one thread. Anything that computes without yielding — a cold
 * store read, a fit over every session — freezes every request, heartbeat and
 * timer behind it, and nothing in the log shows it: the work that blocked
 * logs its own success, and everything that waited simply happens late. On
 * 2026-11-17 the only evidence of a four-minute seizure was 278 proxy errors
 * in ANOTHER process's log.
 *
 * A timer that expects to fire every `intervalMs` measures how late it was.
 * The lateness is the stall, to within one interval, and the log line lands
 * at the moment the loop came back — so whatever logged just before it is
 * the suspect.
 */
export interface LoopLagOptions {
  intervalMs?: number
  /** Report a single stall at least this long. */
  thresholdMs?: number
  now?: () => number
}

export function watchLoopLag(
  report: (stall: { ms: number; at: number }) => void,
  options: LoopLagOptions = {},
): () => void {
  const intervalMs = options.intervalMs ?? 500
  const thresholdMs = options.thresholdMs ?? 2_000
  const now = options.now ?? Date.now
  let expected = now() + intervalMs
  const timer = setInterval(() => {
    const at = now()
    const late = at - expected
    expected = at + intervalMs
    if (late >= thresholdMs) report({ ms: late, at })
  }, intervalMs)
  // Observing the loop must never be what keeps the process alive.
  timer.unref?.()
  return () => clearInterval(timer)
}
