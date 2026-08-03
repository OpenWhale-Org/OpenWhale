import { z } from 'zod'
import { OwMonitor } from '@openwhaleorg/core'
import type { MonitorPlotDef, MonitorRecord } from '@openwhaleorg/core'
import type { MonitorContext } from '@openwhaleorg/core'
import { PublicMarketMonitor, sleep, type ParsedMarketKey } from './PublicMarketMonitor.js'
import type { PerpExchangeAdapter } from '../types/perp.js'

export interface VolumeMonitorOptions {
  /** Poll cadence. Default 60s. */
  pollIntervalMs?: number
}

export interface VolumeUpdate {
  venue: string
  symbol: string
  timestamp: number
  /** Rolling 24h volume, base and quote units. */
  volume24h: number
  quoteVolume24h: number
  lastPrice: number
  /** Change in quoteVolume24h since the previous emit (0 on the first). */
  quoteVolumeChange: number
  /** That change annualized to an hourly rate — comparable across poll cadences. */
  quoteVolumePerHour: number
}

/**
 * Rolling 24h traded volume for one contract.
 *
 * Key: `venue:symbol`.
 *
 * Deliberately the 24h figures, not per-candle volume: KlineMonitor already
 * emits volume per closed candle, and the useful thing this adds is the
 * liquidity BASELINE a symbol trades at, plus how fast it is accumulating.
 * quoteVolumePerHour normalizes the delta so the number means the same thing
 * whether the monitor polls every minute or every ten.
 */
@OwMonitor({
  id: 'volume',
  name: 'Traded Volume (any venue)',
  description: 'Rolling 24h volume plus its accumulation rate per hour. Key: `venue:symbol`',
  params: z.object({
    pollIntervalMs: z.number().default(60_000).meta({ displayName: 'Poll Interval (ms)' }),
  }),
})
export class VolumeMonitor extends PublicMarketMonitor<VolumeUpdate> {
  get monitorName() { return 'volume' }

  private readonly pollIntervalMs: number

  constructor(ctx: MonitorContext, options: VolumeMonitorOptions = {}) {
    super(ctx)
    // Instance params (dashboard-tuned, frozen while active); direct options win in tests
    options = { ...(ctx.params as VolumeMonitorOptions | undefined), ...options }
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000
  }

  override plots(): MonitorPlotDef<VolumeUpdate>[] {
    return [{
      id: 'quote-volume-per-hour',
      title: 'Quote Volume Rate',
      kind: 'line',
      unit: '$/h',
      description: '24h-volume accumulation extrapolated to an hourly rate',
      extract: (records: MonitorRecord<VolumeUpdate>[]) => [
        { label: 'per hour', points: records.map(r => ({ x: r.ts, y: r.data.quoteVolumePerHour })) },
      ],
    }]
  }

  override get emitSchema() {
    return z.object({
      venue: z.string(), symbol: z.string(), timestamp: z.number(),
      volume24h: z.number(), quoteVolume24h: z.number(), lastPrice: z.number(),
      quoteVolumeChange: z.number(),
      quoteVolumePerHour: z.number().meta({ description: 'Delta normalized to a per-hour rate' }),
    })
  }

  protected async feed(
    { venue, symbol }: ParsedMarketKey,
    session: PerpExchangeAdapter,
    emit: (data: VolumeUpdate) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let previousQuote = 0
    let previousAt = 0

    while (!signal.aborted) {
      const ticker = await session.fetchTicker(symbol)
      const now = Date.now()
      const change = previousAt > 0 ? ticker.quoteVolume - previousQuote : 0
      const elapsedHours = previousAt > 0 ? (now - previousAt) / 3_600_000 : 0

      await emit({
        venue, symbol,
        timestamp: ticker.timestamp || now,
        volume24h: ticker.volume,
        quoteVolume24h: ticker.quoteVolume,
        lastPrice: ticker.last,
        quoteVolumeChange: change,
        quoteVolumePerHour: elapsedHours > 0 ? change / elapsedHours : 0,
      })

      previousQuote = ticker.quoteVolume
      previousAt = now
      await sleep(this.pollIntervalMs, signal)
    }
  }
}
