import { describe, it, expect } from 'vitest'
import { streamWithWarmup } from '../watchdog.js'

/**
 * The second watchdog: a stream that spoke and then stopped.
 *
 * The first one only guards the opening silence, so a websocket that delivers
 * for hours and then hangs — no error, no close, an await that never settles —
 * looks identical to a healthy one. Measured on the live board 2026-09-13:
 * two keys went quiet mid-session while twelve others on the same process kept
 * writing, and their charts sat frozen on the last thing each had seen.
 */
describe('streamWithWarmup idle watchdog', () => {
  /** A stream that emits for a while, then goes silent without ending. */
  function hung(frames: number, gapMs: number) {
    let seen = 0
    let lastFrameAt = Date.now()
    let aborted = false
    const run = async (signal: AbortSignal): Promise<void> => {
      for (let i = 0; i < frames; i++) {
        await new Promise(r => setTimeout(r, gapMs))
        if (signal.aborted) { aborted = true; return }
        seen++
        lastFrameAt = Date.now()
      }
      // …and now it hangs, exactly as ccxt does: never resolves, never throws.
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true })
      })
    }
    return { run, seen: () => seen, lastFrameAt: () => lastFrameAt, wasAborted: () => aborted }
  }

  it('aborts a stream that stopped speaking, so the caller can reconnect', async () => {
    const s = hung(3, 10)
    const live = await streamWithWarmup({
      stream: s.run,
      hasEmitted: () => s.seen() > 0,
      signal: new AbortController().signal,
      warmupMs: 5_000,
      idleMs: 120,
      lastFrameAt: s.lastFrameAt,
    })
    expect(s.seen()).toBe(3)
    expect(s.wasAborted()).toBe(true)
    // It DID emit, so the caller reconnects rather than demoting to polling.
    expect(live).toBe(true)
  })

  it('leaves a stream alone while it keeps speaking', async () => {
    const s = hung(8, 10)   // a frame every 10ms against a 500ms idle budget
    const started = Date.now()
    await streamWithWarmup({
      stream: s.run,
      hasEmitted: () => s.seen() > 0,
      signal: new AbortController().signal,
      warmupMs: 5_000,
      idleMs: 500,
      lastFrameAt: s.lastFrameAt,
    })
    expect(s.seen()).toBe(8)          // never cut short mid-flow
    expect(Date.now() - started).toBeGreaterThanOrEqual(80)
  })

  it('does nothing without idleMs — the old behaviour is unchanged', async () => {
    const s = hung(2, 5)
    const outer = new AbortController()
    setTimeout(() => outer.abort(), 200)
    const live = await streamWithWarmup({
      stream: s.run,
      hasEmitted: () => s.seen() > 0,
      signal: outer.signal,
      warmupMs: 5_000,
    })
    // Only the outer abort ended it; the hang itself went unnoticed.
    expect(live).toBe(true)
    expect(s.seen()).toBe(2)
  })

  it('still demotes a stream that never speaks at all', async () => {
    const s = hung(0, 5)
    const live = await streamWithWarmup({
      stream: s.run,
      hasEmitted: () => s.seen() > 0,
      signal: new AbortController().signal,
      warmupMs: 60,
      idleMs: 120,
      lastFrameAt: s.lastFrameAt,
    })
    expect(live).toBe(false)
  })
})
