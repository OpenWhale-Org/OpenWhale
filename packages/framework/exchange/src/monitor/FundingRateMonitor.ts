import { z } from 'zod'
import { OwMonitor } from '@openwhaleorg/core'
import type { MonitorContext, MonitorPlotDef, MonitorRecord } from '@openwhaleorg/core'
import { PublicMarketMonitor, sleep, type ParsedMarketKey } from './PublicMarketMonitor.js'
import type { PerpExchangeAdapter } from '../types/perp.js'
import type { FundingRateData } from '../types/exchange.js'

export interface FundingRateMonitorOptions {
  /** Poll cadence per venue. Default 60s. */
  pollIntervalMs?: number
  /** How often to refresh the venue's settlement-period table. Default 6h. */
  intervalRefreshMs?: number
}

/** One contract's funding state, with the settlement period resolved. */
export interface FundingRateEntry {
  symbol: string
  fundingRate: number
  nextFundingTimestamp: number
  /** Settlement period in hours. */
  intervalHours: number
  /** Where intervalHours came from — 'observed' is exact, 'aligned' is a guess. */
  intervalSource: 'venue' | 'venue-table' | 'observed' | 'aligned'
  /** Milliseconds until the next settlement, at emit time. */
  msToSettlement: number
}

/** Full funding snapshot for one venue — every contract, once a minute. */
export interface FundingSnapshot {
  venue: string
  timestamp: number
  rates: FundingRateEntry[]
}

/**
 * Funding rates for every contract on a venue, over its public session.
 *
 * Subscribe key: the venue name (e.g. 'binance'). One emit per poll carries
 * the whole book of contracts, so a strategy sees the entire opportunity set
 * at once rather than reacting to per-symbol dribble.
 *
 * ── Settlement period ──────────────────────────────────────────────────────
 * Contracts do not share a period: Binance runs 8h, 4h and 1h side by side
 * (measured: 282 / 442 / 5 contracts), Hyperliquid is hourly. The period
 * decides whether a rate is attractive — 0.3% per hour and 0.3% per 8 hours
 * are different propositions — and no single source reports it everywhere, so
 * it is resolved through four fallbacks, best first:
 *
 *   venue        the rate itself states it (Hyperliquid)
 *   venue-table  a dedicated endpoint states it (Binance fetchFundingIntervals)
 *   observed     EXACT: measured from a settlement timestamp actually rolling
 *                over between two polls. Overrides everything once seen.
 *   aligned      inferred from where the settlement sits in the UTC day: an
 *                hour not divisible by 4 can only be hourly; divisible by 4
 *                but not 8 is at most 4h. Conservative — never claims a
 *                shorter period than the alignment permits.
 *
 * Learned periods live in memory, so a restart re-derives them; the first two
 * sources cover the venues we ship, and `aligned` covers the rest immediately.
 */
@OwMonitor({
  id: 'funding-rates',
  name: 'Funding Rates (any venue)',
  description: "Every contract's funding rate on a venue, once a minute, with the settlement period resolved per contract (venue field → venue table → observed rollover → UTC alignment). Key: the venue name.",
  params: z.object({
    pollIntervalMs: z.number().default(60_000).meta({ displayName: 'Poll Interval (ms)' }),
    intervalRefreshMs: z.number().default(21_600_000).meta({ displayName: 'Interval-Table Refresh (ms)', description: "How often to refresh the venue's settlement-period table" }),
  }),
})
export class FundingRateMonitor extends PublicMarketMonitor<FundingSnapshot> {
  get monitorName() { return 'funding-rates' }

  private readonly pollIntervalMs: number
  private readonly intervalRefreshMs: number

  /** venue → symbol → hours, from the venue's own interval endpoint. */
  private readonly venueTables = new Map<string, Record<string, number>>()
  private readonly venueTableFetchedAt = new Map<string, number>()
  /** `${venue}::${symbol}` → exact period measured from an observed rollover. */
  private readonly observed = new Map<string, number>()
  /** `${venue}::${symbol}` → the settlement timestamp seen on the previous poll. */
  private readonly lastSettlement = new Map<string, number>()

  constructor(ctx: MonitorContext, options: FundingRateMonitorOptions = {}) {
    super(ctx)
    // Instance params (dashboard-tuned, frozen while active); direct options win in tests
    options = { ...(ctx.params as FundingRateMonitorOptions | undefined), ...options }
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000
    this.intervalRefreshMs = options.intervalRefreshMs ?? 6 * 3_600_000
  }

  override get emitSchema() {
    return z.object({
      venue: z.string(),
      timestamp: z.number(),
      rates: z.array(z.object({
        symbol: z.string(),
        fundingRate: z.number().meta({ description: 'Decimal, e.g. 0.0001 = 0.01%' }),
        nextFundingTimestamp: z.number(),
        intervalHours: z.number(),
        intervalSource: z.enum(['venue', 'venue-table', 'observed', 'aligned']),
        msToSettlement: z.number(),
      })),
    })
  }

  /**
   * Per-contract funding-rate trend — a multi-select panel because a venue
   * carries hundreds of contracts and drawing them all is unreadable. The
   * picker defaults to the five largest |rate| right now; every stored
   * snapshot contributes one point per minute per selected contract.
   */
  override plots(): MonitorPlotDef<FundingSnapshot>[] {
    return [{
      id: 'rates',
      title: 'Funding rate per contract',
      kind: 'line',
      unit: '%',
      multi: true,
      description: 'One point per minute; the label carries the current rate and settlement interval',
      options: (records: MonitorRecord<FundingSnapshot>[]) => {
        const latest = records[records.length - 1]?.data
        if (!latest) return []
        return [...latest.rates]
          .sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate))
          .map((e, i) => ({
            value: e.symbol,
            label: `${e.symbol}  ${(e.fundingRate * 100).toFixed(4)}%/${e.intervalHours}h`,
            ...(i < 5 ? { default: true } : {}),
          }))
      },
      extract: (records, option) => (option ?? []).map(symbol => ({
        label: symbol,
        points: records.flatMap((r) => {
          const entry = r.data.rates.find(x => x.symbol === symbol)
          return entry ? [{ x: r.ts, y: entry.fundingRate * 100 }] : []
        }),
      })),
    }]
  }

  protected async feed(
    { venue }: ParsedMarketKey,
    session: PerpExchangeAdapter,
    emit: (data: FundingSnapshot) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      await this.refreshVenueTable(venue, session)

      const raw = await session.fetchFundingRates()
      const now = Date.now()
      const rates = raw
        .filter(r => r.nextFundingTimestamp > 0)
        .map(r => this.resolveEntry(venue, r, now))

      await emit({ venue, timestamp: now, rates })
      await sleep(this.pollIntervalMs, signal)
    }
  }

  /** The venue name is the whole key — this feed covers every contract on it. */
  protected override get keyShape() { return 'venue' as const }

  private async refreshVenueTable(venue: string, session: PerpExchangeAdapter): Promise<void> {
    const fetchedAt = this.venueTableFetchedAt.get(venue) ?? 0
    if (Date.now() - fetchedAt < this.intervalRefreshMs) return
    // Mark first: a venue without the endpoint must not be re-probed every poll
    this.venueTableFetchedAt.set(venue, Date.now())
    if (!session.fetchFundingIntervals) return
    try {
      this.venueTables.set(venue, await session.fetchFundingIntervals())
    } catch {
      // Non-fatal: the other three fallbacks still resolve a period
    }
  }

  private resolveEntry(venue: string, rate: FundingRateData, now: number): FundingRateEntry {
    const stateKey = `${venue}::${rate.symbol}`

    // Exact measurement: the settlement we saw last poll has rolled forward,
    // and the gap between the two IS the period.
    const previous = this.lastSettlement.get(stateKey)
    if (previous !== undefined && rate.nextFundingTimestamp > previous) {
      const measuredHours = (rate.nextFundingTimestamp - previous) / 3_600_000
      if (measuredHours >= 0.5 && measuredHours <= 24) {
        this.observed.set(stateKey, roundToKnownPeriod(measuredHours))
      }
    }
    this.lastSettlement.set(stateKey, rate.nextFundingTimestamp)

    const observed = this.observed.get(stateKey)
    if (observed) return entry(rate, observed, 'observed', now)
    if (rate.intervalHours) return entry(rate, rate.intervalHours, 'venue', now)
    const fromTable = this.venueTables.get(venue)?.[rate.symbol]
    if (fromTable) return entry(rate, fromTable, 'venue-table', now)
    return entry(rate, alignedIntervalHours(rate.nextFundingTimestamp), 'aligned', now)
  }
}

function entry(
  rate: FundingRateData,
  intervalHours: number,
  intervalSource: FundingRateEntry['intervalSource'],
  now: number,
): FundingRateEntry {
  return {
    symbol: rate.symbol,
    fundingRate: rate.fundingRate,
    nextFundingTimestamp: rate.nextFundingTimestamp,
    intervalHours,
    intervalSource,
    msToSettlement: rate.nextFundingTimestamp - now,
  }
}

/** Snap a measured gap to the nearest period venues actually use. */
function roundToKnownPeriod(hours: number): number {
  const known = [1, 2, 4, 8]
  return known.reduce((best, candidate) =>
    Math.abs(candidate - hours) < Math.abs(best - hours) ? candidate : best, known[0]!)
}

/**
 * Longest period consistent with where the settlement falls in the UTC day.
 * 8h contracts settle at 00/08/16, 4h at 00/04/08/…, 1h every hour — so an
 * off-grid hour rules the longer periods out. Deliberately conservative: an
 * unknown contract is assumed to settle rarely until a rollover proves otherwise.
 */
export function alignedIntervalHours(settlementTimestamp: number): number {
  const hour = new Date(settlementTimestamp).getUTCHours()
  if (hour % 8 === 0) return 8
  if (hour % 4 === 0) return 4
  if (hour % 2 === 0) return 2
  return 1
}
