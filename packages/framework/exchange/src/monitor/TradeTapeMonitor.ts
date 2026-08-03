import { z } from 'zod'
import { OwMonitor } from '@openwhaleorg/core'
import type { MonitorContext, MonitorPlotDef, MonitorRecord } from '@openwhaleorg/core'
import { PublicMarketMonitor, type ParsedMarketKey } from './PublicMarketMonitor.js'
import type { PerpExchangeAdapter } from '../types/perp.js'

export interface TradeTapeMonitorOptions {
  /** Aggregation window. Default 5s. */
  windowMs?: number
  /** Emit an extra window immediately when a single trade's notional exceeds this (0 = off). */
  largeTradeUsd?: number
}

export interface TradeTapeUpdate {
  venue: string
  symbol: string
  /** Window bounds (ms). */
  windowStart: number
  windowEnd: number
  tradeCount: number
  /** Base-asset volume, split by aggressor side. */
  volume: number
  buyVolume: number
  sellVolume: number
  /** buyVolume / volume: >0.5 buyer-aggressive, <0.5 seller-aggressive. */
  buyRatio: number
  /** Volume-weighted average price over the window. */
  vwap: number
  lastPrice: number
  /** Largest single trade in the window, by notional. */
  largestTradeUsd: number
  largestTradeSide: 'buy' | 'sell' | null
  /** True when the window was cut short by a large trade rather than by time. */
  triggeredByLargeTrade: boolean
}

/**
 * Public trade tape, aggregated into fixed windows.
 *
 * Key: `venue:symbol`.
 *
 * Aggregation is the point: raw tape on a liquid pair is hundreds of prints a
 * second, useless as a trigger and expensive to persist. What strategies use
 * is order-flow pressure — volume, buy/sell aggressor split, VWAP — plus
 * whale prints, so a configurable notional threshold flushes the window early
 * instead of letting a big trade sit unreported until the next tick.
 */
@OwMonitor({
  id: 'trades',
  name: 'Trade Tape (any venue)',
  description: 'Public tape aggregated per window: volume, buy/sell aggressor split, VWAP, whale prints. Key: `venue:symbol`',
  params: z.object({
    windowMs: z.number().default(5_000).meta({ displayName: 'Aggregation Window (ms)' }),
    largeTradeUsd: z.number().default(0).meta({ displayName: 'Whale Print Threshold (USD)', description: 'Emit an extra window immediately when a single trade exceeds this (0 = off)' }),
  }),
})
export class TradeTapeMonitor extends PublicMarketMonitor<TradeTapeUpdate> {
  get monitorName() { return 'trades' }

  private readonly windowMs: number
  private readonly largeTradeUsd: number

  constructor(ctx: MonitorContext, options: TradeTapeMonitorOptions = {}) {
    super(ctx)
    // Instance params (dashboard-tuned, frozen while active); direct options win in tests
    options = { ...(ctx.params as TradeTapeMonitorOptions | undefined), ...options }
    this.windowMs = options.windowMs ?? 5_000
    this.largeTradeUsd = options.largeTradeUsd ?? 0
  }

  override plots(): MonitorPlotDef<TradeTapeUpdate>[] {
    return [
      {
        id: 'flow',
        title: 'Taker Flow',
        kind: 'bar',
        description: 'Aggressive volume per window, split by side — who is crossing the spread',
        extract: (records: MonitorRecord<TradeTapeUpdate>[]) => [
          { label: 'buy', points: records.map(r => ({ x: r.data.windowEnd, y: r.data.buyVolume })) },
          { label: 'sell', points: records.map(r => ({ x: r.data.windowEnd, y: r.data.sellVolume })) },
        ],
      },
      {
        id: 'buy-ratio',
        title: 'Buy Ratio',
        kind: 'line',
        unit: '%',
        description: 'buyVolume / volume per window. 50% is balanced; sustained departures are the imbalance a taker-flow signal reads.',
        extract: (records: MonitorRecord<TradeTapeUpdate>[]) => [
          { label: 'buy ratio', points: records.map(r => ({ x: r.data.windowEnd, y: r.data.buyRatio * 100 })) },
        ],
      },
      {
        id: 'vwap',
        title: 'VWAP vs Last',
        kind: 'line',
        unit: '$',
        description: 'Window VWAP against the window\'s closing print — last above VWAP means the window ended being bought up',
        extract: (records: MonitorRecord<TradeTapeUpdate>[]) => [
          { label: 'vwap', points: records.map(r => ({ x: r.data.windowEnd, y: r.data.vwap })) },
          { label: 'last', points: records.map(r => ({ x: r.data.windowEnd, y: r.data.lastPrice })) },
        ],
      },
      {
        id: 'largest-trade',
        title: 'Largest Trade',
        kind: 'bar',
        unit: '$',
        description: 'Biggest single fill per window, signed by side (positive = buy). The spikes are the prints worth explaining.',
        extract: (records: MonitorRecord<TradeTapeUpdate>[]) => [
          {
            label: 'largest',
            points: records.map(r => ({
              x: r.data.windowEnd,
              y: r.data.largestTradeSide === 'sell' ? -r.data.largestTradeUsd : r.data.largestTradeUsd,
            })),
          },
        ],
      },
    ]
  }

  override get emitSchema() {
    return z.object({
      venue: z.string(), symbol: z.string(),
      windowStart: z.number(), windowEnd: z.number(),
      tradeCount: z.number(), volume: z.number(), buyVolume: z.number(), sellVolume: z.number(),
      buyRatio: z.number().meta({ description: 'buyVolume/volume — >0.5 is buyer-aggressive' }),
      vwap: z.number(), lastPrice: z.number(),
      largestTradeUsd: z.number(), largestTradeSide: z.enum(['buy', 'sell']).nullable(),
      triggeredByLargeTrade: z.boolean(),
    })
  }

  protected async feed(
    { venue, symbol }: ParsedMarketKey,
    session: PerpExchangeAdapter,
    emit: (data: TradeTapeUpdate) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let window = newWindow(Date.now())

    const flush = (triggeredByLargeTrade: boolean) => {
      if (window.tradeCount === 0) { window = newWindow(Date.now()); return }
      const { windowStart, tradeCount, volume, buyVolume, sellVolume, notional, lastPrice, largestTradeUsd, largestTradeSide } = window
      void emit({
        venue, symbol,
        windowStart, windowEnd: Date.now(),
        tradeCount, volume, buyVolume, sellVolume,
        buyRatio: volume > 0 ? buyVolume / volume : 0,
        vwap: volume > 0 ? notional / volume : 0,
        lastPrice, largestTradeUsd, largestTradeSide, triggeredByLargeTrade,
      })
      window = newWindow(Date.now())
    }

    const timer = setInterval(() => flush(false), this.windowMs)
    signal.addEventListener('abort', () => clearInterval(timer), { once: true })

    try {
      await session.watchTrades(symbol, (trades) => {
        for (const trade of trades) {
          const notional = trade.cost > 0 ? trade.cost : trade.price * trade.amount
          window.tradeCount++
          window.volume += trade.amount
          window.notional += notional
          window.lastPrice = trade.price
          if (trade.side === 'buy') window.buyVolume += trade.amount
          else window.sellVolume += trade.amount
          if (notional > window.largestTradeUsd) {
            window.largestTradeUsd = notional
            window.largestTradeSide = trade.side
          }
          if (this.largeTradeUsd > 0 && notional >= this.largeTradeUsd) flush(true)
        }
      }, signal)
    } finally {
      clearInterval(timer)
    }
  }
}

interface Window {
  windowStart: number
  tradeCount: number
  volume: number
  buyVolume: number
  sellVolume: number
  notional: number
  lastPrice: number
  largestTradeUsd: number
  largestTradeSide: 'buy' | 'sell' | null
}

function newWindow(start: number): Window {
  return {
    windowStart: start, tradeCount: 0, volume: 0, buyVolume: 0, sellVolume: 0,
    notional: 0, lastPrice: 0, largestTradeUsd: 0, largestTradeSide: null,
  }
}
