import { z } from 'zod'
import { OwMonitor } from '@openwhaleorg/core'
import type { MonitorContext } from '@openwhaleorg/core'
import { PublicMarketMonitor, parseMarketKey, sleep, type ParsedMarketKey } from './PublicMarketMonitor.js'
import type { PerpExchangeAdapter } from '../types/perp.js'
import type { Kline } from '../types/exchange.js'

export interface KlineMonitorOptions {
  /** Poll cadence override. Default: timeframe/20, clamped to [5s, 60s]. */
  pollIntervalMs?: number
  /** Closed candles to backfill on a key's first subscribe. 0 disables. */
  backfillBars?: number
}

export interface KlineUpdate extends Kline {
  venue: string
  symbol: string
  timeframe: string
  /** Candle close timestamp (timestamp + one timeframe). */
  closeTime: number
}

export const KLINE_TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '3d', '1w'] as const
export type KlineTimeframe = typeof KLINE_TIMEFRAMES[number]

const TIMEFRAME_MS: Record<KlineTimeframe, number> = {
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000, '6h': 21_600_000, '12h': 43_200_000,
  '1d': 86_400_000, '3d': 259_200_000, '1w': 604_800_000,
}

/**
 * OHLCV candles — emits CLOSED candles only, exactly once each.
 *
 * Key: `venue:symbol:timeframe`, e.g. 'binance:BTC/USDT:USDT:1m'.
 *
 * Closed-only is the important property: an in-progress candle repaints (its
 * high/low/close keep changing), so a strategy that acts on one is acting on
 * data that no longer exists a second later. Every emit here is final, which
 * is what indicator maths — moving averages, breakouts, ATR — assumes.
 *
 * Polls fetchOHLCV rather than streaming: the adapter surface has no
 * watchOHLCV, and for closed candles a poll a fraction of the timeframe long
 * is equivalent in latency terms while costing far fewer connections.
 */
@OwMonitor({
  id: 'klines',
  name: 'OHLCV Candles (any venue)',
  description: 'Closed candles only, emitted once each — safe for indicator maths. Key: `venue:symbol:timeframe`, e.g. binance:BTC/USDT:USDT:1m',
  params: z.object({
    pollIntervalMs: z.number().optional().meta({ displayName: 'Poll Interval (ms)', description: 'Override; default adapts to the timeframe (timeframe/20, clamped to [5s, 60s])' }),
    backfillBars: z.number().int().min(0).max(1_500).default(500).meta({
      displayName: 'Backfill bars',
      description: 'Closed candles fetched on a key\'s first subscribe so indicators have history immediately. 0 disables. Capped by the venue\'s single-request kline limit.',
    }),
  }),
})
export class KlineMonitor extends PublicMarketMonitor<KlineUpdate> {
  get monitorName() { return 'klines' }
  protected override get keyShape() { return 'symbol+extra' as const }

  override get keySchema() {
    return z.object({
      venue: this.venueField(),
      symbol: this.symbolField(),
      // Enum, not a bare string: the form gets a dropdown and keyFor()
      // rejects an unsupported timeframe before a feed ever starts
      timeframe: z.enum(KLINE_TIMEFRAMES).default('1m').meta({
        displayName: 'Timeframe',
        description: 'Candle period — closed candles only, one emit each',
        options: KLINE_TIMEFRAMES.map(t => ({ label: t, value: t })),
      }),
    })
  }

  private readonly pollIntervalOverride: number | undefined
  private readonly backfillBars: number

  constructor(ctx: MonitorContext, options: KlineMonitorOptions = {}) {
    super(ctx)
    // Instance params (dashboard-tuned, frozen while active); direct options win in tests
    options = { ...(ctx.params as KlineMonitorOptions | undefined), ...options }
    this.pollIntervalOverride = options.pollIntervalMs
    this.backfillBars = options.backfillBars ?? 500
  }

  /**
   * Candles are the archetypal reconstructable feed: the venue serves the same
   * closed bars whether we were listening or not, so a first subscribe (or a
   * restart after downtime) fills the gap instead of starting blind.
   *
   * Incremental by the file's own watermark — only bars strictly newer than
   * `since` are fetched, and the venue's single-request limit caps how far
   * back a cold start can reach (no pagination on the adapter surface).
   */
  protected override async backfill(
    key: string,
    since: number | undefined,
    _signal: AbortSignal,
  ): Promise<Array<{ ts: number; data: KlineUpdate }>> {
    if (this.backfillBars <= 0) return []
    const parsed = parseMarketKey(key, 'symbol+extra')
    if (!parsed) return []
    const { venue, symbol, extra } = parsed
    const timeframe = extra!
    const timeframeMs = TIMEFRAME_MS[timeframe as KlineTimeframe]
    if (!timeframeMs) return []

    // Only fetch as far back as the gap needs — a warm key after a short
    // outage costs one small request instead of the full window.
    const bars = since === undefined
      ? this.backfillBars
      : Math.min(this.backfillBars, Math.ceil((Date.now() - since) / timeframeMs) + 2)

    const session = await this.adapters.resolve<PerpExchangeAdapter>('exchange/perp', venue)
    const candles = await session.fetchOHLCV(symbol, timeframe, bars + 1)
    // Drop the still-forming newest candle: only final bars are persisted.
    const closed = candles.length > 0 ? candles.slice(0, -1) : candles

    // A candle's record ts is its CLOSE time — that is when the data became
    // true, and it keeps the file ordered against live emits (which append at
    // wall-clock time shortly after the same close).
    return closed.map(c => ({
      ts: c.timestamp + timeframeMs,
      data: { ...c, venue, symbol, timeframe, closeTime: c.timestamp + timeframeMs },
    }))
  }

  override get emitSchema() {
    return z.object({
      venue: z.string(), symbol: z.string(), timeframe: z.string(),
      timestamp: z.number().meta({ description: 'Candle open time (ms)' }),
      closeTime: z.number(),
      open: z.number(), high: z.number(), low: z.number(), close: z.number(), volume: z.number(),
    })
  }

  protected async feed(
    { venue, symbol, extra }: ParsedMarketKey,
    session: PerpExchangeAdapter,
    emit: (data: KlineUpdate) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const timeframe = extra!
    const timeframeMs = TIMEFRAME_MS[timeframe as KlineTimeframe]
    if (!timeframeMs) {
      throw new Error(`Unsupported timeframe "${timeframe}" — use one of ${KLINE_TIMEFRAMES.join(', ')}`)
    }
    const pollIntervalMs = this.pollIntervalOverride ?? Math.min(Math.max(timeframeMs / 20, 5_000), 60_000)

    // Seed the watermark from what is already stored, so a bar that closed
    // between the backfill's fetch and this first poll is emitted rather than
    // silently adopted as the baseline (that window is otherwise a data hole).
    // With no stored history there is nothing to continue from: adopt the
    // current bar instead of replaying — subscribers asked for new bars.
    const key = [venue, symbol, timeframe].join(':')
    const stored = await this.getReader().readLatest(key)
    let lastEmitted = (stored?.data as KlineUpdate | undefined)?.timestamp ?? 0

    while (!signal.aborted) {
      // The newest candle is still forming; the one before it is final.
      const candles = await session.fetchOHLCV(symbol, timeframe, 3)
      const closed = candles.length >= 2 ? candles[candles.length - 2] : undefined

      if (closed && closed.timestamp > lastEmitted) {
        if (lastEmitted > 0) {
          await emit({ ...closed, venue, symbol, timeframe, closeTime: closed.timestamp + timeframeMs })
        }
        lastEmitted = closed.timestamp
      }

      await sleep(pollIntervalMs, signal)
    }
  }
}
