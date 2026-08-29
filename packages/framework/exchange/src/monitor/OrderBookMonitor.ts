import { z } from 'zod'
import { OwMonitor } from '@openwhaleorg/core'
import type { MonitorPlotDef, MonitorRecord } from '@openwhaleorg/core'
import type { MonitorContext } from '@openwhaleorg/core'
import { PublicMarketMonitor, sleep, type ParsedMarketKey } from './PublicMarketMonitor.js'
import type { PerpExchangeAdapter } from '../types/perp.js'
import type { OrderBook } from '../types/exchange.js'

export interface OrderBookMonitorOptions {
  /** Levels to stream and aggregate over. Default 20. */
  depth?: number
  /** Floor between emits per key. Default 1s. */
  minIntervalMs?: number
}

export interface OrderBookUpdate {
  venue: string
  symbol: string
  timestamp: number
  bestBid: number
  bestAsk: number
  mid: number
  /** Absolute spread and its value in basis points of mid. */
  spread: number
  spreadBps: number
  /** Summed size over the tracked levels, per side. */
  bidVolume: number
  askVolume: number
  /** (bidVolume − askVolume) / (bidVolume + askVolume): +1 all bids, −1 all asks. */
  imbalance: number
  /** Top levels, as [price, amount][] — for strategies that need the shape itself. */
  bids: [number, number][]
  asks: [number, number][]
}

/**
 * Order book depth, spread and imbalance.
 *
 * Key: `venue:symbol`.
 *
 * Emits derived microstructure metrics rather than a raw book: spread (in bps,
 * so it compares across assets) and top-of-book imbalance are the signals
 * strategies actually condition on, and a market maker or grid also needs them
 * to decide whether quoting is worth it at all. Raw top levels ride along.
 */
@OwMonitor({
  id: 'orderbook',
  name: 'Order Book Depth (any venue)',
  description: 'Spread (bps), top-of-book imbalance and depth levels, throttled. Key: `venue:symbol`',
  params: z.object({
    depth: z.number().default(20).meta({ displayName: 'Depth Levels' }),
    minIntervalMs: z.number().default(1_000).meta({ displayName: 'Min Emit Interval (ms)' }),
  }),
})
export class OrderBookMonitor extends PublicMarketMonitor<OrderBookUpdate> {
  get monitorName() { return 'orderbook' }

  private readonly depth: number
  private readonly minIntervalMs: number

  constructor(ctx: MonitorContext, options: OrderBookMonitorOptions = {}) {
    super(ctx)
    // Instance params (dashboard-tuned, frozen while active); direct options win in tests
    options = { ...(ctx.params as OrderBookMonitorOptions | undefined), ...options }
    this.depth = options.depth ?? 20
    this.minIntervalMs = options.minIntervalMs ?? 1_000
  }

  override plots(): MonitorPlotDef<OrderBookUpdate>[] {
    return [
      {
        id: 'spread',
        title: 'Spread',
        kind: 'line',
        unit: 'bps',
        description: 'Bid/ask spread in basis points of mid',
        extract: (records: MonitorRecord<OrderBookUpdate>[]) => [
          { label: 'spread', points: records.map(r => ({ x: r.ts, y: r.data.spreadBps })) },
        ],
      },
      {
        id: 'book-volume',
        title: 'Book Volume',
        kind: 'line',
        description: 'Summed size per side over the tracked levels',
        extract: (records: MonitorRecord<OrderBookUpdate>[]) => [
          { label: 'bids', points: records.map(r => ({ x: r.ts, y: r.data.bidVolume })) },
          { label: 'asks', points: records.map(r => ({ x: r.ts, y: r.data.askVolume })) },
        ],
      },
    ]
  }

  override get emitSchema() {
    return z.object({
      venue: z.string(), symbol: z.string(), timestamp: z.number(),
      bestBid: z.number(), bestAsk: z.number(), mid: z.number(),
      spread: z.number(), spreadBps: z.number().meta({ description: 'Spread in basis points of mid' }),
      bidVolume: z.number(), askVolume: z.number(),
      imbalance: z.number().meta({ description: '(bidVol − askVol)/(bidVol + askVol), −1..+1' }),
    })
  }

  protected async feed(
    { venue, symbol }: ParsedMarketKey,
    session: PerpExchangeAdapter,
    emit: (data: OrderBookUpdate) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let lastEmitAt = 0

    await session.watchOrderBook(symbol, (book) => {
      const now = Date.now()
      if (now - lastEmitAt < this.minIntervalMs) return
      const update = this.derive(venue, symbol, book, now)
      if (!update) return
      lastEmitAt = now
      void emit(update)
    }, this.depth, signal)
  }

  /**
   * REST fallback for venues whose stream says `has.watchOrderBook` and then
   * delivers nothing (Aster, as of 2026-08). Same record, same throttle — the
   * only difference is where the book came from, and a strategy cannot tell.
   */
  protected override async pollFeed(
    { venue, symbol }: ParsedMarketKey,
    session: PerpExchangeAdapter,
    emit: (data: OrderBookUpdate) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      const book = await session.fetchOrderBook(symbol, this.depth)
      const update = this.derive(venue, symbol, book, Date.now())
      if (update) await emit(update)
      await sleep(Math.max(this.minIntervalMs, 1_000), signal)
    }
  }

  /** One book → one record, or undefined when the book says nothing usable. */
  private derive(venue: string, symbol: string, book: OrderBook, now: number): OrderBookUpdate | undefined {
    const bestBid = book.bids[0]?.[0] ?? 0
    const bestAsk = book.asks[0]?.[0] ?? 0
    if (bestBid <= 0 || bestAsk <= 0) return undefined   // one-sided book: nothing meaningful to derive

    const bids = book.bids.slice(0, this.depth)
    const asks = book.asks.slice(0, this.depth)
    const bidVolume = bids.reduce((sum, [, amount]) => sum + amount, 0)
    const askVolume = asks.reduce((sum, [, amount]) => sum + amount, 0)
    const totalVolume = bidVolume + askVolume
    const mid = (bestBid + bestAsk) / 2

    return {
      venue, symbol, timestamp: book.timestamp || now,
      bestBid, bestAsk, mid,
      spread: bestAsk - bestBid,
      spreadBps: mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0,
      bidVolume, askVolume,
      imbalance: totalVolume > 0 ? (bidVolume - askVolume) / totalVolume : 0,
      bids, asks,
    }
  }
}
