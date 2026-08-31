import { describe, it, expect, vi } from 'vitest'
import { patchWsEventNames, AsterAdapter, AsterPublicAdapter } from '../adapter.js'

/**
 * Aster's websocket was not the mute one — ours was deaf.
 *
 * Measured against the venue on 2026-08-31: `snxxusdt@depth20` delivered 42
 * frames in 12 seconds, first at 514ms. ccxt 4.5.52 then dropped every one of
 * them, because its dispatch table is keyed by stream suffix ('depth20') while
 * the venue sends Binance's event names ('depthUpdate'). No error, no throw —
 * `watchOrderBook` simply never resolves, and a strategy goes quiet with
 * nothing to restart on.
 */

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const MASTER = '0x35a5B33Be664B09F78b5089eb6185f71c8a7f11f'

function spyExchange() {
  const seen: unknown[] = []
  const ex = { handleMessage: (_client: unknown, message: unknown) => { seen.push(message) } }
  patchWsEventNames(ex)
  return { ex, seen }
}

/** The frame shape the combined-stream endpoint sends. */
const framed = (e: string) => ({ stream: `snxxusdt@x`, data: { e, s: 'SNXXUSDT' } })

describe('Aster websocket event names', () => {
  it('routes a depth frame to the handler ccxt keys as depth20', () => {
    const { ex, seen } = spyExchange()
    ex.handleMessage(null, framed('depthUpdate'))
    expect((seen[0] as { data: { e: string } }).data.e).toBe('depth20')
  })

  it('routes both ticker flavours to the ticker handler', () => {
    const { ex, seen } = spyExchange()
    ex.handleMessage(null, framed('24hrTicker'))
    ex.handleMessage(null, framed('markPriceUpdate'))
    expect((seen[0] as { data: { e: string } }).data.e).toBe('ticker')
    expect((seen[1] as { data: { e: string } }).data.e).toBe('markPrice')
  })

  it('leaves the names ccxt already agrees with alone', () => {
    const { ex, seen } = spyExchange()
    ex.handleMessage(null, framed('bookTicker'))
    ex.handleMessage(null, framed('ORDER_TRADE_UPDATE'))
    expect((seen[0] as { data: { e: string } }).data.e).toBe('bookTicker')
    expect((seen[1] as { data: { e: string } }).data.e).toBe('ORDER_TRADE_UPDATE')
  })

  it('handles an unwrapped frame, and one with no event at all', () => {
    const { ex, seen } = spyExchange()
    ex.handleMessage(null, { e: 'depthUpdate', s: 'SNXXUSDT' })
    ex.handleMessage(null, { result: null, id: 1 })
    expect((seen[0] as { e: string }).e).toBe('depth20')
    expect(seen[1]).toEqual({ result: null, id: 1 })
  })

  /* End to end through ccxt's own dispatcher: a real depth frame must come out
     the other side as a resolved order book. Before the alias it came out as
     nothing at all. */
  it('turns a real depth frame into a resolved order book, on both adapters', () => {
    for (const adapter of [new AsterAdapter({ walletAddress: MASTER, privateKey: KEY }), new AsterPublicAdapter()]) {
      const ex = (adapter as unknown as { exchange: { handleMessage: (c: unknown, m: unknown) => void } }).exchange
      const resolve = vi.fn()
      const client = { url: 'wss://fstream.asterdex.com/stream', resolve }
      ex.handleMessage(client, {
        stream: 'snxxusdt@depth20',
        data: {
          e: 'depthUpdate', E: 1788172234981, T: 1788172234950, s: 'SNXXUSDT',
          U: 523500774520, u: 523500777585, pu: 523500773803,
          b: [['12.91000', '4175.41'], ['12.90000', '42.37']],
          a: [['12.94000', '5876.91']],
        },
      })
      expect(resolve).toHaveBeenCalledTimes(1)
      const [book, hash] = resolve.mock.calls[0] as [{ bids: number[][]; asks: number[][] }, string]
      expect(hash).toMatch(/^orderbook:/)
      expect(book.bids[0]).toEqual([12.91, 4175.41])
      expect(book.asks[0]).toEqual([12.94, 5876.91])
    }
  })
})

/**
 * Aster's `@ticker` stream waits for a trade to print. On the leveraged-equity
 * markets this engine trades, that is minutes — measured on a Sunday, SNXX's
 * ticker stream sent nothing in twelve seconds while its bookTicker sent 403
 * frames. So the quote comes from bookTicker and `last` still comes from a
 * real trade.
 */
describe('the Aster ticker feed', () => {
  it('moves on quotes, keeps last honest, and carries the 24h frame', async () => {
    const adapter = new AsterPublicAdapter()
    const seen: Array<{ bid: number; ask: number; last: number; high: number }> = []
    const ctl = new AbortController()

    const ex = (adapter as unknown as { exchange: Record<string, unknown> }).exchange
    ;(adapter as unknown as { fetchTicker: unknown }).fetchTicker = async () => ({
      symbol: 'SNXX/USDT:USDT', timestamp: 1, last: 12.5, bid: 12.4, ask: 12.6,
      high: 13, low: 12, volume: 100, quoteVolume: 1250,
    })
    const quotes = [{ bid: 12.91, ask: 12.94, timestamp: 2 }, { bid: 12.92, ask: 12.95, timestamp: 3 }]
    ex['watchBidsAsks'] = async () => {
      const next = quotes.shift()
      if (!next) { ctl.abort(); return {} }
      return { 'SNXX/USDT:USDT': next }
    }
    ex['watchTrades'] = async () => {
      await new Promise(r => setTimeout(r, 5))
      return [{ price: 12.93, timestamp: 4 }]
    }

    await adapter.watchTicker('SNXX/USDT:USDT', (t) => seen.push({ bid: t.bid, ask: t.ask, last: t.last, high: t.high }), ctl.signal)

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toMatchObject({ bid: 12.91, ask: 12.94, last: 12.5, high: 13 })
    // `last` only ever changes on a trade — never a mid wearing a trade's name.
    expect(seen.every(s => s.last === 12.5 || s.last === 12.93)).toBe(true)
  })
})
