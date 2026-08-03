import { describe, it, expect } from 'vitest'
import type { MonitorDataReader, MonitorRecord, StrategyParams, StrategyContext } from '@openwhaleorg/core'
import type { Kline, Ticker } from '@openwhaleorg/exchange'
import { MomentumBreakoutStrategy } from '../strategies/MomentumBreakoutStrategy.js'
import { MeanReversionStrategy } from '../strategies/MeanReversionStrategy.js'
import { ScheduledAccumulationStrategy } from '../strategies/ScheduledAccumulationStrategy.js'
import { CopyTradingStrategy } from '../strategies/CopyTradingStrategy.js'

/**
 * Offline strategy tests: every dependency the runtime injects is stubbed, so
 * these run with no venue, no database and no network.
 */

type Position = { id: string; side: string; value: number; pnl: number }

/** A reader that serves a fixed record list for one key. */
function readerOf<T>(key: string, data: T[]): MonitorDataReader {
  const records = data.map((d, i) => ({ ts: 1_700_000_000_000 + i * 60_000, data: d })) as MonitorRecord[]
  return {
    keys: async () => [key],
    readLast: async (k: string, n: number) => (k === key ? records.slice(-n) : []),
    readAll: async (k: string) => (k === key ? records : []),
    readLatest: async (k: string) => (k === key ? records[records.length - 1] ?? null : null),
    readRange: async (k: string) => (k === key ? records : []),
    count: async (k: string) => (k === key ? records.length : 0),
    readAllLatest: async () => ({ [key]: records[records.length - 1]! }),
    readAllLast: async (n: number) => ({ [key]: records.slice(-n) }),
  } as unknown as MonitorDataReader
}

/** Wire a strategy the way the runtime does, with stub readers and account. */
function prepare<S extends {
  setParams(p: StrategyParams): void
  setAccountMeta(m: Array<{ label: string; accountName: string; venue: string; kind: string }>): void
  setReaders(r: unknown[], names: string[]): void
  setMonitorReader(label: string, reader: MonitorDataReader): void
}>(strategy: S, opts: {
  params: StrategyParams
  positions?: Position[]
  readers?: Record<string, MonitorDataReader>
}): S {
  strategy.setParams(opts.params)
  strategy.setAccountMeta([{ label: 'main', accountName: 'Test', venue: 'binance', kind: 'exchange/perp' }])
  strategy.setReaders([{ positions: async () => opts.positions ?? [] }], ['Test'])
  for (const [label, reader] of Object.entries(opts.readers ?? {})) strategy.setMonitorReader(label, reader)
  return strategy
}

const candle = (close: number, high = close, low = close): Kline => ({
  timestamp: 0, open: close, high, low, close, volume: 100,
})

const ctx = { triggerId: 't1', monitorData: {} } as unknown as StrategyContext

describe('MomentumBreakoutStrategy', () => {
  const params = {
    base: { symbol: 'BTC/USDT:USDT', timeframe: '1h', notionalUsd: 500, maxPositionUsd: 1000 },
    tunable: { entryLookback: 5, exitLookback: 3, allowShort: false, slippage: 0.005 },
  }
  const key = 'binance:BTC/USDT:USDT:1h'

  it('buys when the close breaks above the channel', async () => {
    const bars = [10, 11, 10, 11, 10, 20].map(c => candle(c))
    const s = prepare(new MomentumBreakoutStrategy(), { params, readers: { candles: readerOf(key, bars) } })
    const out = await s.evaluate(ctx)
    expect(out).toHaveLength(1)
    expect(out[0]!.params).toMatchObject({ symbol: 'BTC/USDT:USDT', side: 'buy', type: 'market' })
    expect(out[0]!.params['amount']).toBeCloseTo(500 / 20, 8)
  })

  it('stays flat inside the channel', async () => {
    const bars = [10, 11, 10, 11, 10, 10.5].map(c => candle(c))
    const s = prepare(new MomentumBreakoutStrategy(), { params, readers: { candles: readerOf(key, bars) } })
    expect(await s.evaluate(ctx)).toHaveLength(0)
  })

  it('exits a long on the downside break without flipping short', async () => {
    const bars = [10, 11, 10, 11, 10, 5].map(c => candle(c))
    const s = prepare(new MomentumBreakoutStrategy(), {
      params,
      positions: [{ id: 'BTC/USDT:USDT', side: 'long', value: 800, pnl: 0 }],
      readers: { candles: readerOf(key, bars) },
    })
    const out = await s.evaluate(ctx)
    expect(out).toHaveLength(1)
    expect(out[0]!.params).toMatchObject({ side: 'sell', reduceOnly: true })
    expect(out[0]!.params['amount']).toBeCloseTo(800 / 5, 8)   // sweeps the whole position
  })

  it('emits nothing once the position cap is reached', async () => {
    const bars = [10, 11, 10, 11, 10, 20].map(c => candle(c))
    const s = prepare(new MomentumBreakoutStrategy(), {
      params,
      positions: [{ id: 'BTC/USDT:USDT', side: 'long', value: 1000, pnl: 0 }],
      readers: { candles: readerOf(key, bars) },
    })
    expect(await s.evaluate(ctx)).toHaveLength(0)
  })

  it('does nothing without enough history', async () => {
    const s = prepare(new MomentumBreakoutStrategy(), {
      params, readers: { candles: readerOf(key, [candle(10), candle(11)]) },
    })
    expect(await s.evaluate(ctx)).toHaveLength(0)
  })
})

describe('MeanReversionStrategy', () => {
  const params = {
    base: { symbol: 'ETH/USDT:USDT', timeframe: '15m', notionalUsd: 300, maxPositionUsd: 900 },
    tunable: { period: 5, entryZ: 1.5, exitZ: 0.5, slippage: 0.005 },
  }
  const key = 'binance:ETH/USDT:USDT:15m'

  it('sells a spike above the mean', async () => {
    const bars = [100, 100, 100, 100, 110].map(c => candle(c))
    const s = prepare(new MeanReversionStrategy(), { params, readers: { candles: readerOf(key, bars) } })
    const out = await s.evaluate(ctx)
    expect(out).toHaveLength(1)
    expect(out[0]!.params).toMatchObject({ side: 'sell' })
  })

  it('buys a dip below the mean', async () => {
    const bars = [100, 100, 100, 100, 90].map(c => candle(c))
    const s = prepare(new MeanReversionStrategy(), { params, readers: { candles: readerOf(key, bars) } })
    const out = await s.evaluate(ctx)
    expect(out[0]!.params).toMatchObject({ side: 'buy' })
  })

  it('flattens an open position once the z-score decays', async () => {
    const bars = [100, 101, 99, 100, 100.2].map(c => candle(c))
    const s = prepare(new MeanReversionStrategy(), {
      params,
      positions: [{ id: 'ETH/USDT:USDT', side: 'short', value: 300, pnl: 0 }],
      readers: { candles: readerOf(key, bars) },
    })
    const out = await s.evaluate(ctx)
    expect(out).toHaveLength(1)
    expect(out[0]!.params).toMatchObject({ side: 'buy', reduceOnly: true })
  })
})

describe('ScheduledAccumulationStrategy', () => {
  const params = {
    base: { symbol: 'BTC/USDT:USDT', usdPerBuy: 100, targetUsd: 500 },
    tunable: { schedule: '0 0 */4 * * *', dipLookback: 3, dipMultiplier: 2, slippage: 0.005 },
  }
  const key = 'binance:BTC/USDT:USDT'
  const tick = (last: number) => ({ symbol: 'BTC/USDT:USDT', timestamp: 0, last, bid: last, ask: last, high: last, low: last, volume: 1, quoteVolume: 1 }) as Ticker

  it('doubles the clip when the price is below its average', async () => {
    const s = prepare(new ScheduledAccumulationStrategy(), {
      params, readers: { price: readerOf(key, [tick(100), tick(100), tick(70)]) },
    })
    const out = await s.evaluate(ctx)
    expect(out[0]!.params['amount']).toBeCloseTo(200 / 70, 8)
  })

  it('buys the base clip at or above the average', async () => {
    const s = prepare(new ScheduledAccumulationStrategy(), {
      params, readers: { price: readerOf(key, [tick(100), tick(100), tick(130)]) },
    })
    const out = await s.evaluate(ctx)
    expect(out[0]!.params['amount']).toBeCloseTo(100 / 130, 8)
  })

  it('never overshoots the target on the last clip', async () => {
    const s = prepare(new ScheduledAccumulationStrategy(), {
      params,
      positions: [{ id: 'BTC/USDT:USDT', side: 'long', value: 450, pnl: 0 }],
      readers: { price: readerOf(key, [tick(100), tick(100), tick(100)]) },
    })
    const out = await s.evaluate(ctx)
    expect(out[0]!.params['amount']).toBeCloseTo(50 / 100, 8)   // headroom, not the full clip
  })

  it('idles once the target is reached', async () => {
    const s = prepare(new ScheduledAccumulationStrategy(), {
      params,
      positions: [{ id: 'BTC/USDT:USDT', side: 'long', value: 500, pnl: 0 }],
      readers: { price: readerOf(key, [tick(100)]) },
    })
    expect(await s.evaluate(ctx)).toHaveLength(0)
  })
})

describe('CopyTradingStrategy', () => {
  const address = '0x1111111111111111111111111111111111111111'
  const params = {
    base: { targetAddress: address, ratio: 0.5, maxPositionUsd: 1000 },
    tunable: { minTradeUsd: 10, slippage: 0.005 },
  }
  const withTrade = (trade: unknown) => ({
    triggerId: 't1',
    getData: (label: string, key: string) => (label === 'trades' && key === address ? trade : undefined),
  } as unknown as StrategyContext)

  it('mirrors a fill at the configured ratio', async () => {
    const s = prepare(new CopyTradingStrategy(), { params })
    const out = await s.evaluate(withTrade({
      symbol: 'BTC/USDC:USDC', side: 'buy', price: 100, amount: 4, cost: 400, takerOrMaker: 'taker',
    }))
    expect(out).toHaveLength(1)
    expect(out[0]!.params['amount']).toBeCloseTo(200 / 100, 8)   // 400 × 0.5 ÷ price
  })

  it('skips fills below the noise floor', async () => {
    const s = prepare(new CopyTradingStrategy(), { params })
    const out = await s.evaluate(withTrade({
      symbol: 'BTC/USDC:USDC', side: 'buy', price: 100, amount: 0.1, cost: 10, takerOrMaker: 'taker',
    }))
    expect(out).toHaveLength(0)
  })

  it('mirrors a close as reduce-only, never flipping through zero', async () => {
    const s = prepare(new CopyTradingStrategy(), {
      params,
      positions: [{ id: 'BTC/USDC:USDC', side: 'long', value: 100, pnl: 0 }],
    })
    const out = await s.evaluate(withTrade({
      symbol: 'BTC/USDC:USDC', side: 'sell', price: 100, amount: 40, cost: 4000, takerOrMaker: 'taker',
    }))
    expect(out[0]!.params).toMatchObject({ side: 'sell', reduceOnly: true })
    expect(out[0]!.params['amount']).toBeCloseTo(100 / 100, 8)   // capped at the open exposure
  })
})
