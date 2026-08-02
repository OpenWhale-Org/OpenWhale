import { z } from 'zod'
import { OwMonitor } from '@openwhaleorg/core'
import type { MonitorPlotDef, MonitorRecord } from '@openwhaleorg/core'
import type { MonitorContext } from '@openwhaleorg/core'
import { PublicMarketMonitor, type ParsedMarketKey } from './PublicMarketMonitor.js'
import type { PerpExchangeAdapter } from '../types/perp.js'
import type { Ticker } from '../types/exchange.js'

export interface TickerMonitorOptions {
  /** Floor between emits per key. Default 1s — venues push tickers far faster than any strategy needs. */
  minIntervalMs?: number
  /** Also emit immediately when the price moves at least this fraction since the last emit (e.g. 0.001 = 0.1%). */
  emitOnPriceChangePct?: number
}

export interface TickerUpdate extends Ticker {
  venue: string
  /** Mid price ((bid+ask)/2), falling back to `last` when a side is missing. */
  mid: number
  /** Fractional price change since the previous emit for this key (0 on the first). */
  changePct: number
}

/**
 * Real-time price feed — the most common signal source there is.
 *
 * Key: `venue:symbol`, e.g. 'binance:BTC/USDT:USDT' or 'hyperliquid:BTC/USDC:USDC'.
 *
 * Throttled by design: a raw venue ticker stream fires many times per second,
 * and every emit both persists a JSONL record and evaluates triggers. The
 * defaults emit at most once a second, plus immediately on a configured price
 * move so breakout-style strategies stay responsive.
 */
@OwMonitor({
  id: 'ticker',
  name: 'Ticker (any venue)',
  description: 'Real-time price/bid/ask over keyless adapter cells, throttled. Key: `venue:symbol`, e.g. binance:BTC/USDT:USDT',
  params: z.object({
    minIntervalMs: z.number().default(1_000).meta({ displayName: 'Min Emit Interval (ms)', description: 'Floor between emits per key' }),
    emitOnPriceChangePct: z.number().default(0).meta({ displayName: 'Emit on Price Move (fraction)', description: 'Also emit immediately on a move of at least this fraction (0 = off)' }),
  }),
})
export class TickerMonitor extends PublicMarketMonitor<TickerUpdate> {
  get monitorName() { return 'ticker' }

  private readonly minIntervalMs: number
  private readonly emitOnPriceChangePct: number

  constructor(ctx: MonitorContext, options: TickerMonitorOptions = {}) {
    super(ctx)
    // Instance params (dashboard-tuned, frozen while active); direct options win in tests
    options = { ...(ctx.params as TickerMonitorOptions | undefined), ...options }
    this.minIntervalMs = options.minIntervalMs ?? 1_000
    this.emitOnPriceChangePct = options.emitOnPriceChangePct ?? 0
  }

  override plots(): MonitorPlotDef<TickerUpdate>[] {
    return [{
      id: 'price',
      title: 'Price',
      kind: 'line',
      unit: '$',
      description: 'Last trade price and mid ((bid+ask)/2) over the stored window',
      extract: (records: MonitorRecord<TickerUpdate>[]) => [
        { label: 'last', points: records.map(r => ({ x: r.ts, y: r.data.last })) },
        { label: 'mid', points: records.map(r => ({ x: r.ts, y: r.data.mid })) },
      ],
    }]
  }

  override get emitSchema() {
    return z.object({
      venue: z.string(), symbol: z.string(), timestamp: z.number(),
      last: z.number().meta({ description: 'Last trade price' }),
      bid: z.number(), ask: z.number(), mid: z.number(),
      high: z.number(), low: z.number(), volume: z.number(), quoteVolume: z.number(),
      changePct: z.number().meta({ description: 'Fractional price change since the previous emit' }),
    })
  }

  protected async feed(
    { venue, symbol }: ParsedMarketKey,
    session: PerpExchangeAdapter,
    emit: (data: TickerUpdate) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let lastEmitAt = 0
    let lastPrice = 0

    await session.watchTicker(symbol, (ticker) => {
      const now = Date.now()
      const price = ticker.last || (ticker.bid + ticker.ask) / 2
      const changePct = lastPrice > 0 ? (price - lastPrice) / lastPrice : 0

      const dueByTime = now - lastEmitAt >= this.minIntervalMs
      const dueByMove = this.emitOnPriceChangePct > 0 && Math.abs(changePct) >= this.emitOnPriceChangePct
      if (!dueByTime && !dueByMove) return

      lastEmitAt = now
      lastPrice = price
      void emit({
        ...ticker,
        venue,
        mid: ticker.bid > 0 && ticker.ask > 0 ? (ticker.bid + ticker.ask) / 2 : ticker.last,
        changePct,
      })
    }, signal)
  }
}
