import { describe, it, expect, vi } from 'vitest'
import { OrderBookMonitor } from '../OrderBookMonitor.js'
import type { PerpExchangeAdapter } from '../../types/perp.js'
import type { OrderBook } from '../../types/exchange.js'

/**
 * A venue can advertise `has.watchOrderBook` and then deliver nothing at all:
 * the await never settles, so there is no throw to restart on and the key
 * simply goes quiet (Aster, 2026-08). These pin the watchdog that notices.
 */

const BOOK: OrderBook = {
  symbol: 'SNXX/USDT:USDT',
  timestamp: 1_700_000_000_000,
  bids: [[12.9, 500], [12.8, 200]],
  asks: [[13.0, 400], [13.1, 100]],
}

/** A session whose watch hangs for ever and whose REST book answers at once. */
function muteWatchSession(): PerpExchangeAdapter & { fetchOrderBook: ReturnType<typeof vi.fn> } {
  const session = {
    watchOrderBook: (_s: string, _cb: unknown, _d?: number, signal?: AbortSignal) =>
      new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true })),
    fetchOrderBook: vi.fn(async () => BOOK),
  }
  return session as unknown as PerpExchangeAdapter & { fetchOrderBook: ReturnType<typeof vi.fn> }
}

function monitorOn(session: PerpExchangeAdapter, dataDir: string, pollWindowMs = 60_000) {
  const m = new OrderBookMonitor({ adapters: { resolve: async () => session } as never, dataDir }, { minIntervalMs: 0 })
  // A short warmup keeps the test honest about time without waiting 15s
  Object.defineProperty(m, 'watchWarmupMs', { get: () => 30 })
  Object.defineProperty(m, 'pollWindowMs', { get: () => pollWindowMs })
  return m
}

describe('a mute websocket falls back to REST', () => {
  it('polls the key after the warmup, and the record is the one the watch would have emitted', async () => {
    const session = muteWatchSession()
    const emitted: unknown[] = []
    const m = monitorOn(session, `/tmp/ow-test-${Date.now()}`)
    m.addEmitHandler(async (_key, data) => { emitted.push(data) })

    m.subscribe('aster:SNXX/USDT:USDT')
    await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(0), { timeout: 3_000 })
    m.unsubscribe('aster:SNXX/USDT:USDT')

    expect(session.fetchOrderBook).toHaveBeenCalled()
    const first = emitted[0] as { venue: string; bestBid: number; bestAsk: number; spreadBps: number }
    expect(first.venue).toBe('aster')
    expect(first.bestBid).toBe(12.9)
    expect(first.bestAsk).toBe(13.0)
    expect(first.spreadBps).toBeCloseTo(((13.0 - 12.9) / 12.95) * 10_000, 6)
  })

  it('leaves a live websocket alone — no polling when the stream speaks', async () => {
    const fetchOrderBook = vi.fn(async () => BOOK)
    const session = {
      watchOrderBook: async (_s: string, cb: (b: OrderBook) => void, _d?: number, signal?: AbortSignal) => {
        cb(BOOK)
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
      fetchOrderBook,
    } as unknown as PerpExchangeAdapter
    const emitted: unknown[] = []
    const m = monitorOn(session, `/tmp/ow-test-${Date.now()}-live`)
    m.addEmitHandler(async (_key, data) => { emitted.push(data) })

    m.subscribe('aster:SNXX/USDT:USDT')
    await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(0), { timeout: 3_000 })
    await new Promise(r => setTimeout(r, 120))   // past the warmup
    m.unsubscribe('aster:SNXX/USDT:USDT')

    expect(fetchOrderBook).not.toHaveBeenCalled()
  })

  it('retries the stream after the poll window — a quiet market is not a broken socket', async () => {
    // Silent at first (an out-of-hours market), talking by the second attempt.
    let attempts = 0
    const session = {
      watchOrderBook: async (_s: string, cb: (b: OrderBook) => void, _d?: number, signal?: AbortSignal) => {
        if (++attempts > 1) cb(BOOK)
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
      fetchOrderBook: vi.fn(async () => BOOK),
    } as unknown as PerpExchangeAdapter
    const m = monitorOn(session, `/tmp/ow-test-${Date.now()}-retry`, 50)

    m.subscribe('aster:SNXX/USDT:USDT')
    await vi.waitFor(() => expect(attempts).toBeGreaterThan(1), { timeout: 3_000 })
    m.unsubscribe('aster:SNXX/USDT:USDT')
  })
})
