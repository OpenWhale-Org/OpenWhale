import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { MonitorContext, AdapterResolver } from '@openwhaleorg/core'
import { parseMarketKey } from '../PublicMarketMonitor.js'
import { TickerMonitor, type TickerUpdate } from '../TickerMonitor.js'
import { FundingRateMonitor } from '../FundingRateMonitor.js'
import { KlineMonitor, type KlineUpdate } from '../KlineMonitor.js'
import { OrderBookMonitor, type OrderBookUpdate } from '../OrderBookMonitor.js'
import { TradeTapeMonitor, type TradeTapeUpdate } from '../TradeTapeMonitor.js'
import type { Ticker, OrderBook, ExchangeTrade, Kline } from '../../types/exchange.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-market-monitors-'))
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

function ctxFor(session: unknown): MonitorContext {
  const adapters: AdapterResolver = { types: () => ['fake'], has: () => true, resolve: async <T,>() => session as T }
  return { adapters, dataDir: tmpDir }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Poll until the condition holds (5s cap) — robust under parallel-suite CPU contention. */
async function waitFor(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(10)
  }
}

describe('parseMarketKey', () => {
  it('keeps colons inside ccxt perp symbols out of the venue/extra split', () => {
    expect(parseMarketKey('binance:BTC/USDT:USDT')).toEqual({ venue: 'binance', symbol: 'BTC/USDT:USDT' })
    expect(parseMarketKey('binance:BTC/USDT:USDT:1m', 'symbol+extra')).toEqual({ venue: 'binance', symbol: 'BTC/USDT:USDT', extra: '1m' })
    expect(parseMarketKey('binance:BTC/USDT:1m', 'symbol+extra')).toEqual({ venue: 'binance', symbol: 'BTC/USDT', extra: '1m' })
    expect(parseMarketKey('binance:BTC/USDT', 'symbol+extra')).toBeUndefined()   // qualifier required but absent
    expect(parseMarketKey('binance')).toBeUndefined()                            // 'symbol' shape needs a symbol
    expect(parseMarketKey('binance', 'venue')).toEqual({ venue: 'binance', symbol: '' })
    expect(parseMarketKey('binance:BTC/USDT', 'venue')).toBeUndefined()           // venue shape takes no extra segments
  })
})

describe('key schemas', () => {
  const ctxAccessor: MonitorContext = {
    adapters: { types: () => ['binance', 'hyperliquid'], has: () => true, resolve: async <T,>() => ({} as T) },
    dataDir: tmpDir,
  }

  it('symbol-shaped monitors inherit venue+symbol fields with a live venue dropdown', () => {
    const monitor = new TickerMonitor(ctxAccessor)
    const schema = monitor.keySchema!
    expect(Object.keys(schema.shape)).toEqual(['venue', 'symbol'])

    // Venue options come from the LIVE public-session registry
    const venueMeta = schema.shape.venue!.meta() as { options?: Array<{ value: unknown }> }
    expect(venueMeta.options?.map(o => o.value)).toEqual(['binance', 'hyperliquid'])

    // keyFor composes the ':'-joined key in field order
    expect(monitor.keyFor({ venue: 'binance', symbol: 'BTC/USDT:USDT' })).toBe('binance:BTC/USDT:USDT')
    expect(() => monitor.keyFor({ venue: 'binance' })).toThrow()   // symbol required
  })

  it('venue-shaped monitors take just the venue', () => {
    const monitor = new FundingRateMonitor(ctxAccessor)
    expect(Object.keys(monitor.keySchema!.shape)).toEqual(['venue'])
    expect(monitor.keyFor({ venue: 'binance' })).toBe('binance')
  })

  it('klines constrain the timeframe to supported values and default it', () => {
    const monitor = new KlineMonitor(ctxAccessor)
    expect(Object.keys(monitor.keySchema!.shape)).toEqual(['venue', 'symbol', 'timeframe'])

    expect(monitor.keyFor({ venue: 'binance', symbol: 'BTC/USDT:USDT', timeframe: '5m' })).toBe('binance:BTC/USDT:USDT:5m')
    expect(monitor.keyFor({ venue: 'binance', symbol: 'BTC/USDT:USDT' })).toBe('binance:BTC/USDT:USDT:1m')   // default
    expect(() => monitor.keyFor({ venue: 'binance', symbol: 'BTC/USDT:USDT', timeframe: '7m' })).toThrow()   // unsupported

    // Options ride along for the dashboard select
    const timeframeMeta = monitor.keySchema!.shape.timeframe!.meta() as { options?: unknown[] }
    expect(timeframeMeta.options?.length).toBeGreaterThan(5)
  })
})

describe('TickerMonitor', () => {
  it('throttles by interval, reports change since the last emit, and fires early on a big move', async () => {
    let push: ((t: Ticker) => void) | undefined
    const session = {
      watchTicker: async (_s: string, cb: (t: Ticker) => void, signal?: AbortSignal) => {
        push = cb
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }
    const monitor = new TickerMonitor(ctxFor(session), { minIntervalMs: 10_000,   // effectively "time-based emits off"
      emitOnPriceChangePct: 0.01 })
    const emits: TickerUpdate[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as TickerUpdate) })
    monitor.subscribe('fake:BTC/USDT:USDT')
    // Condition-wait, not fixed sleeps: under full-suite CPU contention the
    // feed's async startup (and the emit chain) can outlast any fixed delay.
    await waitFor(() => push !== undefined)

    const tick = (last: number): Ticker => ({ symbol: 'BTC/USDT:USDT', timestamp: Date.now(), last, bid: last - 1, ask: last + 1, high: 0, low: 0, volume: 0, quoteVolume: 0 })
    push!(tick(100))     // first: emitted (no previous emit time)
    push!(tick(100.2))   // +0.2% — below both thresholds, dropped
    push!(tick(102))     // +2% vs last emit — early emit on move
    await waitFor(() => emits.length >= 2)
    monitor.unsubscribe('fake:BTC/USDT:USDT')

    expect(emits).toHaveLength(2)
    expect(emits[0]!.last).toBe(100)
    expect(emits[0]!.mid).toBe(100)
    expect(emits[1]!.last).toBe(102)
    expect(emits[1]!.changePct).toBeCloseTo(0.02, 6)
  })
})

describe('KlineMonitor', () => {
  it('emits only closed candles, once each, and does not replay history on start', async () => {
    const minute = 60_000
    const base = Math.floor(Date.now() / minute) * minute
    const candle = (i: number): Kline => ({ timestamp: base + i * minute, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })
    // [older closed, closed, forming] — index -2 is the newest closed one
    let series = [candle(-2), candle(-1), candle(0)]
    const session = { fetchOHLCV: async () => series }

    const monitor = new KlineMonitor(ctxFor(session), { pollIntervalMs: 20 })
    const emits: KlineUpdate[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as KlineUpdate) })
    monitor.subscribe('fake:BTC/USDT:USDT:1m')

    await sleep(80)
    expect(emits).toHaveLength(0)   // baseline adopted, nothing replayed

    series = [candle(-1), candle(0), candle(1)]   // one minute later
    await sleep(80)
    monitor.unsubscribe('fake:BTC/USDT:USDT:1m')

    expect(emits).toHaveLength(1)   // exactly one new closed candle, not repeated across polls
    expect(emits[0]!.timestamp).toBe(base)
    expect(emits[0]!.closeTime).toBe(base + minute)
    expect(emits[0]!.timeframe).toBe('1m')
    expect(emits[0]!.symbol).toBe('BTC/USDT:USDT')
  })
})

describe('OrderBookMonitor', () => {
  it('derives spread in bps and imbalance, and skips one-sided books', async () => {
    let push: ((b: OrderBook) => void) | undefined
    const session = {
      watchOrderBook: async (_s: string, cb: (b: OrderBook) => void, _d?: number, signal?: AbortSignal) => {
        push = cb
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }
    const monitor = new OrderBookMonitor(ctxFor(session), { depth: 2, minIntervalMs: 0 })
    const emits: OrderBookUpdate[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as OrderBookUpdate) })
    monitor.subscribe('fake:BTC/USDT:USDT')
    await sleep(50)

    push!({ symbol: 'BTC/USDT:USDT', timestamp: Date.now(), bids: [], asks: [[100, 1]] })          // one-sided → skipped
    push!({ symbol: 'BTC/USDT:USDT', timestamp: Date.now(), bids: [[99.9, 3], [99.8, 3]], asks: [[100.1, 1], [100.2, 1]] })
    await sleep(30)
    monitor.unsubscribe('fake:BTC/USDT:USDT')

    expect(emits).toHaveLength(1)
    const update = emits[0]!
    expect(update.bestBid).toBe(99.9)
    expect(update.bestAsk).toBe(100.1)
    expect(update.mid).toBeCloseTo(100, 6)
    expect(update.spreadBps).toBeCloseTo(20, 1)          // 0.2 / 100 × 10000
    expect(update.bidVolume).toBe(6)
    expect(update.askVolume).toBe(2)
    expect(update.imbalance).toBeCloseTo(0.5, 6)         // (6−2)/8
  })
})

describe('TradeTapeMonitor', () => {
  it('aggregates a window: volume split, VWAP, largest print', async () => {
    let push: ((t: ExchangeTrade[]) => void) | undefined
    const session = {
      watchTrades: async (_s: string, cb: (t: ExchangeTrade[]) => void, signal?: AbortSignal) => {
        push = cb
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }
    const monitor = new TradeTapeMonitor(ctxFor(session), { windowMs: 60 })
    const emits: TradeTapeUpdate[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as TradeTapeUpdate) })
    monitor.subscribe('fake:BTC/USDT:USDT')
    await sleep(40)

    const trade = (side: 'buy' | 'sell', price: number, amount: number): ExchangeTrade =>
      ({ id: String(Math.random()), symbol: 'BTC/USDT:USDT', side, price, amount, cost: price * amount, timestamp: Date.now(), takerOrMaker: 'taker' })
    push!([trade('buy', 100, 3), trade('sell', 102, 1)])
    await sleep(120)
    monitor.unsubscribe('fake:BTC/USDT:USDT')

    const withTrades = emits.filter(e => e.tradeCount > 0)
    expect(withTrades).toHaveLength(1)          // empty windows are not emitted
    const window = withTrades[0]!
    expect(window.tradeCount).toBe(2)
    expect(window.volume).toBe(4)
    expect(window.buyVolume).toBe(3)
    expect(window.buyRatio).toBeCloseTo(0.75, 6)
    expect(window.vwap).toBeCloseTo((100 * 3 + 102 * 1) / 4, 6)
    expect(window.largestTradeUsd).toBe(300)
    expect(window.largestTradeSide).toBe('buy')
    expect(window.triggeredByLargeTrade).toBe(false)
  })

  it('flushes early on a whale print', async () => {
    let push: ((t: ExchangeTrade[]) => void) | undefined
    const session = {
      watchTrades: async (_s: string, cb: (t: ExchangeTrade[]) => void, signal?: AbortSignal) => {
        push = cb
        await new Promise<void>(resolve => signal?.addEventListener('abort', () => resolve(), { once: true }))
      },
    }
    const monitor = new TradeTapeMonitor(ctxFor(session), { windowMs: 60_000, largeTradeUsd: 10_000 })
    const emits: TradeTapeUpdate[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as TradeTapeUpdate) })
    monitor.subscribe('fake:BTC/USDT:USDT')
    await waitFor(() => push !== undefined)

    push!([{ id: 'w', symbol: 'BTC/USDT:USDT', side: 'buy', price: 100, amount: 200, cost: 20_000, timestamp: Date.now(), takerOrMaker: 'taker' }])
    await waitFor(() => emits.length > 0)
    monitor.unsubscribe('fake:BTC/USDT:USDT')

    // The window would not have closed for another minute
    expect(emits).toHaveLength(1)
    expect(emits[0]!.triggeredByLargeTrade).toBe(true)
    expect(emits[0]!.largestTradeUsd).toBe(20_000)
  })
})

describe('FundingRateMonitor plots', () => {
  it('defaults to the five largest |rate| and draws one point per snapshot', async () => {
    const { FundingRateMonitor } = await import('../FundingRateMonitor.js')
    const monitor = new FundingRateMonitor({
      adapters: { types: () => ['binance'], has: () => true, resolve: async <T,>() => ({} as T) },
      dataDir: tmpDir,
    } as never)
    const plot = monitor.plots()[0]!
    expect(plot.multi).toBe(true)

    const entry = (symbol: string, rate: number) => ({
      symbol, fundingRate: rate, nextFundingTimestamp: 1, intervalHours: 8,
      intervalSource: 'venue' as const, msToSettlement: 1,
    })
    const records = [0, 1].map(i => ({
      ts: 60_000 * i,
      data: {
        venue: 'binance', timestamp: 60_000 * i,
        rates: [entry('AAA', 0.004 + i * 0.001), entry('BBB', -0.006), entry('CCC', 0.0001),
                entry('DDD', 0.002), entry('EEE', -0.003), entry('FFF', 0.0009), entry('GGG', 0.0008)],
      },
    }))

    const options = plot.options!(records as never)
    expect(options[0]!.value).toBe('BBB')                       // largest |rate| first
    expect(options.filter(o => o.default).map(o => o.value)).toEqual(['BBB', 'AAA', 'EEE', 'DDD', 'FFF'])
    expect(options[0]!.label).toContain('%/8h')

    const series = (plot.extract as (r: never, o: string[]) => Array<{ label: string; points: Array<{ x: number; y: number }> }>)(
      records as never, ['AAA'])
    expect(series).toHaveLength(1)
    expect(series[0]!.points).toEqual([{ x: 0, y: 0.4 }, { x: 60_000, y: 0.5 }])
  })
})
