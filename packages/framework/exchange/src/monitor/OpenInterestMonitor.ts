import { z } from 'zod'
import { OwMonitor } from '@openwhaleorg/core'
import type { MonitorContext, MonitorPlotDef, MonitorRecord } from '@openwhaleorg/core'
import { PublicMarketMonitor, sleep, type ParsedMarketKey } from './PublicMarketMonitor.js'
import type { PerpExchangeAdapter } from '../types/perp.js'

export interface OpenInterestMonitorOptions {
  /** Poll cadence. Default 60s. */
  pollIntervalMs?: number
}

export interface OpenInterestUpdate {
  venue: string
  symbol: string
  timestamp: number
  /** Open contracts, base units. */
  amount: number
  /** Notional value when the venue reports it. */
  value?: number
  /** Change in `amount` since the previous emit (0 on the first). */
  amountChange: number
  /** Fractional change since the previous emit — position build-up or unwind. */
  changePct: number
}

/**
 * Open interest for one contract.
 *
 * Key: `venue:symbol`.
 *
 * Emits the level plus its change since the last poll: OI direction is the
 * signal (rising OI with rising price means new longs; falling OI means
 * positions closing), and the change is what strategies condition on.
 */
@OwMonitor({
  id: 'open-interest',
  name: 'Open Interest (any venue)',
  description: 'Open interest level plus its change since the last poll. Key: `venue:symbol`',
  params: z.object({
    pollIntervalMs: z.number().default(60_000).meta({ displayName: 'Poll Interval (ms)' }),
  }),
})
export class OpenInterestMonitor extends PublicMarketMonitor<OpenInterestUpdate> {
  get monitorName() { return 'open-interest' }

  private readonly pollIntervalMs: number

  constructor(ctx: MonitorContext, options: OpenInterestMonitorOptions = {}) {
    super(ctx)
    // Instance params (dashboard-tuned, frozen while active); direct options win in tests
    options = { ...(ctx.params as OpenInterestMonitorOptions | undefined), ...options }
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000
  }

  override plots(): MonitorPlotDef<OpenInterestUpdate>[] {
    return [
      {
        id: 'open-interest',
        title: 'Open Interest',
        kind: 'line',
        description: 'Open contracts in base units, and their USD value where the venue reports one',
        extract: (records: MonitorRecord<OpenInterestUpdate>[]) => {
          const series = [{ label: 'contracts', points: records.map(r => ({ x: r.ts, y: r.data.amount })) }]
          // Only venues that price the book report `value` — an all-undefined
          // series would render as an empty legend entry.
          if (records.some(r => r.data.value !== undefined)) {
            series.push({
              label: 'value ($)',
              points: records.filter(r => r.data.value !== undefined).map(r => ({ x: r.ts, y: r.data.value! })),
            })
          }
          return series
        },
      },
      {
        id: 'oi-change',
        title: 'OI Change',
        kind: 'bar',
        unit: '%',
        description: 'Percentage change since the previous emit — positioning building (positive) or unwinding (negative)',
        extract: (records: MonitorRecord<OpenInterestUpdate>[]) => [
          { label: 'change', points: records.map(r => ({ x: r.ts, y: r.data.changePct * 100 })) },
        ],
      },
    ]
  }

  override get emitSchema() {
    return z.object({
      venue: z.string(), symbol: z.string(), timestamp: z.number(),
      amount: z.number().meta({ description: 'Open contracts, base units' }),
      value: z.number().optional(),
      amountChange: z.number(), changePct: z.number(),
    })
  }

  protected async feed(
    { venue, symbol }: ParsedMarketKey,
    session: PerpExchangeAdapter,
    emit: (data: OpenInterestUpdate) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (!session.fetchOpenInterest) {
      throw new Error(`Venue "${venue}" does not report open interest`)
    }

    let previous = 0
    while (!signal.aborted) {
      const oi = await session.fetchOpenInterest(symbol)
      const amountChange = previous > 0 ? oi.amount - previous : 0
      await emit({
        venue, symbol,
        timestamp: oi.timestamp,
        amount: oi.amount,
        ...(oi.value !== undefined ? { value: oi.value } : {}),
        amountChange,
        changePct: previous > 0 ? amountChange / previous : 0,
      })
      previous = oi.amount
      await sleep(this.pollIntervalMs, signal)
    }
  }
}
