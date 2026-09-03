import { describe, it, expect } from 'vitest'
import { streamWithWarmup } from '../watchdog.js'

/**
 * Whatever a stream starts must die with the call that started it.
 *
 * A two-leg feed is a Promise.all of two watchers sharing one child signal.
 * When one leg rejects, the other is still running — still holding the
 * caller's callbacks and the caller's state — and the caller, seeing a
 * rejection, starts a fresh pair. Two emitters for one key: one live, one
 * frozen at the last price it saw. Measured 2026-09-03 on binance SNXX/SNDK,
 * every record arrived twice, two milliseconds apart, the A leg alternating
 * between a live price and a dead one while B matched exactly.
 */

/** A watcher that runs until its signal aborts, or fails on demand. */
function leg(fail?: Error) {
  let signal: AbortSignal | undefined
  const run = (s: AbortSignal) => new Promise<void>((resolve, reject) => {
    signal = s
    if (fail) { reject(fail); return }
    s.addEventListener('abort', () => resolve(), { once: true })
  })
  return { run, aborted: () => signal?.aborted === true }
}

describe('streamWithWarmup tears down what it started', () => {
  it('aborts the surviving leg when the other one rejects', async () => {
    const a = leg(new Error('socket reset'))
    const b = leg()
    const outer = new AbortController()

    await expect(streamWithWarmup({
      stream: s => Promise.all([a.run(s), b.run(s)]).then(() => undefined),
      hasEmitted: () => true,
      signal: outer.signal,
    })).rejects.toThrow('socket reset')

    // The leg that did not fail must not outlive the call: the caller is about
    // to start a fresh pair, and this one would keep emitting beside it.
    expect(b.aborted()).toBe(true)
  })

  it('aborts the stream when the warmup expires without an emit', async () => {
    const a = leg()
    const outer = new AbortController()
    const live = await streamWithWarmup({
      stream: s => a.run(s),
      hasEmitted: () => false,
      signal: outer.signal,
      warmupMs: 20,
    })
    expect(live).toBe(false)
    expect(a.aborted()).toBe(true)
  })

  it('aborts the stream when the caller aborts', async () => {
    const a = leg()
    const outer = new AbortController()
    const pending = streamWithWarmup({ stream: s => a.run(s), hasEmitted: () => true, signal: outer.signal })
    outer.abort()
    expect(await pending).toBe(true)
    expect(a.aborted()).toBe(true)
  })
})
