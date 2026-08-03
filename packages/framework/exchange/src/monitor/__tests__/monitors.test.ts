import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { MonitorContext, AdapterResolver } from '@openwhaleorg/core'
import { FundingRateMonitor, alignedIntervalHours, type FundingSnapshot } from '../FundingRateMonitor.js'
import { OpenInterestMonitor, type OpenInterestUpdate } from '../OpenInterestMonitor.js'
import { VolumeMonitor, type VolumeUpdate } from '../VolumeMonitor.js'
import type { FundingRateData, OpenInterestData, Ticker } from '../../types/exchange.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-exchange-monitors-'))
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

/** A settlement timestamp at a given UTC hour today. */
function atUtcHour(hour: number): number {
  const d = new Date()
  d.setUTCHours(hour, 0, 0, 0)
  return d.getTime()
}

describe('alignedIntervalHours', () => {
  it('never claims a shorter period than the settlement hour permits', () => {
    expect(alignedIntervalHours(atUtcHour(0))).toBe(8)    // 8h grid
    expect(alignedIntervalHours(atUtcHour(16))).toBe(8)
    expect(alignedIntervalHours(atUtcHour(4))).toBe(4)    // 4h grid, not 8h
    expect(alignedIntervalHours(atUtcHour(20))).toBe(4)
    expect(alignedIntervalHours(atUtcHour(2))).toBe(2)
    expect(alignedIntervalHours(atUtcHour(7))).toBe(1)    // off-grid ⇒ hourly
  })
})

describe('FundingRateMonitor', () => {
  it('emits every contract per poll and resolves the period from the venue field', async () => {
    const rates: FundingRateData[] = [
      { symbol: 'AAA', fundingRate: 0.002, fundingTimestamp: 0, nextFundingTimestamp: atUtcHour(7), intervalHours: 1 },
      { symbol: 'BBB', fundingRate: -0.0015, fundingTimestamp: 0, nextFundingTimestamp: atUtcHour(16) },
      { symbol: 'NOSETTLE', fundingRate: 0.01, fundingTimestamp: 0, nextFundingTimestamp: 0 },
    ]
    const monitor = new FundingRateMonitor(ctxFor({ fetchFundingRates: async () => rates }), { pollIntervalMs: 10_000 })
    const emits: FundingSnapshot[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as FundingSnapshot) })
    monitor.subscribe('fake')
    await waitFor(() => emits.length > 0)
    monitor.unsubscribe('fake')

    expect(emits).toHaveLength(1)
    const snapshot = emits[0]!
    expect(snapshot.venue).toBe('fake')
    // Contracts without a next settlement are dropped — nothing to arbitrage
    expect(snapshot.rates.map(r => r.symbol)).toEqual(['AAA', 'BBB'])

    const aaa = snapshot.rates[0]!
    expect(aaa.intervalHours).toBe(1)
    expect(aaa.intervalSource).toBe('venue')
    // Counts down toward the settlement; assert the relationship, not a
    // wall-clock delta (emit and assertion are milliseconds apart)
    expect(aaa.msToSettlement).toBe(aaa.nextFundingTimestamp - snapshot.timestamp)

    // No venue field and no table ⇒ conservative UTC-alignment guess
    expect(snapshot.rates[1]!.intervalSource).toBe('aligned')
    expect(snapshot.rates[1]!.intervalHours).toBe(8)
  })

  it("prefers the venue's interval table over alignment", async () => {
    const monitor = new FundingRateMonitor(ctxFor({
        fetchFundingRates: async (): Promise<FundingRateData[]> => [
          { symbol: 'AAA', fundingRate: 0.002, fundingTimestamp: 0, nextFundingTimestamp: atUtcHour(16) },
        ],
        fetchFundingIntervals: async () => ({ AAA: 4 }),
      }), { pollIntervalMs: 10_000 })
    const emits: FundingSnapshot[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as FundingSnapshot) })
    monitor.subscribe('fake')
    await waitFor(() => emits.length > 0)
    monitor.unsubscribe('fake')

    expect(emits[0]!.rates[0]!.intervalHours).toBe(4)          // table wins over the 8h alignment guess
    expect(emits[0]!.rates[0]!.intervalSource).toBe('venue-table')
  })

  it('measures the exact period when a settlement rolls over, overriding the guess', async () => {
    const first = atUtcHour(16)
    let settlement = first
    const monitor = new FundingRateMonitor(ctxFor({
        fetchFundingRates: async (): Promise<FundingRateData[]> => [
          { symbol: 'AAA', fundingRate: 0.002, fundingTimestamp: 0, nextFundingTimestamp: settlement },
        ],
      }), { pollIntervalMs: 30 })
    const emits: FundingSnapshot[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as FundingSnapshot) })
    monitor.subscribe('fake')

    await waitFor(() => emits.length > 0)
    expect(emits[0]!.rates[0]!.intervalSource).toBe('aligned')   // 16:00 ⇒ guessed 8h
    settlement = first + 4 * 3_600_000                            // rolls forward by 4h
    await waitFor(() => emits.some(e => e.rates[0]!.intervalSource === 'observed'))
    monitor.unsubscribe('fake')

    const last = emits[emits.length - 1]!.rates[0]!
    expect(last.intervalSource).toBe('observed')
    expect(last.intervalHours).toBe(4)                            // measured, not guessed
  })
})

describe('OpenInterestMonitor', () => {
  it('reports the level and its change between polls', async () => {
    let amount = 1000
    const session = {
      fetchOpenInterest: async (symbol: string): Promise<OpenInterestData> =>
        ({ symbol, timestamp: Date.now(), amount, value: amount * 2 }),
    }
    const monitor = new OpenInterestMonitor(ctxFor(session), { pollIntervalMs: 30 })
    const emits: OpenInterestUpdate[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as OpenInterestUpdate) })
    monitor.subscribe('fake:BTC/USDT:USDT')

    await waitFor(() => emits.length >= 1)
    amount = 1100
    await waitFor(() => emits.some(e => e.amount === 1100))
    monitor.unsubscribe('fake:BTC/USDT:USDT')

    expect(emits[0]!.amount).toBe(1000)
    expect(emits[0]!.amountChange).toBe(0)      // no baseline on the first emit
    const grew = emits.find(e => e.amount === 1100)!
    expect(grew.amountChange).toBe(100)
    expect(grew.changePct).toBeCloseTo(0.1, 6)
    expect(grew.value).toBe(2200)
  })

  it('fails loudly on venues that do not report open interest', async () => {
    const monitor = new OpenInterestMonitor(ctxFor({}), { pollIntervalMs: 10_000 })
    const emits: unknown[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d) })
    monitor.subscribe('fake:BTC/USDT:USDT')
    await sleep(60)
    monitor.unsubscribe('fake:BTC/USDT:USDT')
    expect(emits).toHaveLength(0)   // the feed throws and backs off rather than emitting junk
  })
})

describe('VolumeMonitor', () => {
  it('normalizes the volume delta to a per-hour rate', async () => {
    let quoteVolume = 1_000_000
    const session = {
      fetchTicker: async (symbol: string): Promise<Ticker> =>
        ({ symbol, timestamp: Date.now(), last: 100, bid: 99, ask: 101, high: 0, low: 0, volume: quoteVolume / 100, quoteVolume }),
    }
    const monitor = new VolumeMonitor(ctxFor(session), { pollIntervalMs: 40 })
    const emits: VolumeUpdate[] = []
    monitor.addEmitHandler(async (_k, d) => { emits.push(d as VolumeUpdate) })
    monitor.subscribe('fake:BTC/USDT:USDT')

    await waitFor(() => emits.length >= 1)
    quoteVolume = 1_000_360      // +360 quote between polls
    await waitFor(() => emits.some(e => e.quoteVolumeChange > 0))
    monitor.unsubscribe('fake:BTC/USDT:USDT')

    expect(emits[0]!.quoteVolume24h).toBe(1_000_000)
    expect(emits[0]!.quoteVolumeChange).toBe(0)
    const grew = emits.find(e => e.quoteVolumeChange > 0)!
    expect(grew.quoteVolumeChange).toBe(360)
    // 360 over ~40ms extrapolates to a very large hourly rate — assert the sign and scale
    expect(grew.quoteVolumePerHour).toBeGreaterThan(360 * 1_000)
  })
})
