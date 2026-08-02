import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { AdapterResolver } from '@openwhaleorg/core'
import { KlineMonitor, type KlineUpdate } from '../KlineMonitor.js'
import type { Kline } from '../../types/exchange.js'

const HOUR = 3_600_000

/** Adapter serving a deterministic hourly candle series ending at `lastOpen`. */
function makeAdapters(lastOpen: number, calls: Array<{ symbol: string; limit: number }> = []) {
  const session = {
    async fetchOHLCV(symbol: string, _tf: string, limit = 100): Promise<Kline[]> {
      calls.push({ symbol, limit })
      return Array.from({ length: limit }, (_, i) => {
        const timestamp = lastOpen - (limit - 1 - i) * HOUR
        return { timestamp, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 }
      })
    },
  }
  const adapters = {
    types: () => ['binance'],
    has: () => true,
    resolve: async () => session,
  } as unknown as AdapterResolver
  return { adapters, calls }
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

let dataDir: string
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-kline-backfill-')) })

const KEY = 'binance:BTC/USDT:USDT:1h'

function readRecords(): Array<{ ts: number; data: KlineUpdate }> {
  const file = path.join(dataDir, 'monitors', 'klines', `${KEY}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

/** Run only the backfill, without starting the live poll loop. */
function backfillOnly(monitor: KlineMonitor, key: string, since: number | undefined) {
  const hook = (monitor as unknown as {
    backfill(k: string, s: number | undefined, sig: AbortSignal): Promise<Array<{ ts: number; data: KlineUpdate }>>
  }).backfill
  return hook.call(monitor, key, since, new AbortController().signal)
}

describe('KlineMonitor backfill', () => {
  it('advertises the capability', () => {
    const { adapters } = makeAdapters(0)
    expect(new KlineMonitor({ adapters, dataDir }).supportsBackfill).toBe(true)
  })

  it('returns closed candles stamped at their CLOSE time, dropping the forming one', async () => {
    const lastOpen = 100 * HOUR
    const { adapters } = makeAdapters(lastOpen)
    const monitor = new KlineMonitor({ adapters, dataDir }, { backfillBars: 5 })

    const records = await backfillOnly(monitor, KEY, undefined)
    expect(records).toHaveLength(5)
    // Newest returned bar is the one BEFORE the still-forming newest candle.
    expect(records.at(-1)!.data.timestamp).toBe(lastOpen - HOUR)
    // ts is the candle's close time, one timeframe past its open.
    for (const r of records) expect(r.ts).toBe(r.data.timestamp + HOUR)
    expect(records.map(r => r.ts)).toEqual([...records.map(r => r.ts)].sort((a, b) => a - b))
  })

  it('carries the key fields into each record', async () => {
    const { adapters } = makeAdapters(10 * HOUR)
    const monitor = new KlineMonitor({ adapters, dataDir }, { backfillBars: 3 })
    const [first] = await backfillOnly(monitor, KEY, undefined)
    expect(first!.data).toMatchObject({ venue: 'binance', symbol: 'BTC/USDT:USDT', timeframe: '1h' })
    expect(first!.data.closeTime).toBe(first!.data.timestamp + HOUR)
  })

  it('is incremental: a warm key fetches only the gap, not the full window', async () => {
    // The gap is measured watermark→now, so anchor the series at real time.
    const lastOpen = Math.floor(Date.now() / HOUR) * HOUR
    const calls: Array<{ symbol: string; limit: number }> = []
    const { adapters } = makeAdapters(lastOpen, calls)
    const monitor = new KlineMonitor({ adapters, dataDir }, { backfillBars: 500 })

    // Stored watermark 3 hours back → a handful of bars, not 500.
    await backfillOnly(monitor, KEY, Date.now() - 3 * HOUR)
    expect(calls[0]!.limit).toBeLessThan(20)

    // Cold key → the full configured window.
    calls.length = 0
    await backfillOnly(monitor, KEY, undefined)
    expect(calls[0]!.limit).toBe(501)
  })

  it('backfillBars: 0 disables it entirely — no venue request', async () => {
    const calls: Array<{ symbol: string; limit: number }> = []
    const { adapters } = makeAdapters(10 * HOUR, calls)
    const monitor = new KlineMonitor({ adapters, dataDir }, { backfillBars: 0 })
    expect(await backfillOnly(monitor, KEY, undefined)).toEqual([])
    expect(calls).toEqual([])
  })

  it('an unparseable key yields nothing rather than throwing', async () => {
    const { adapters } = makeAdapters(10 * HOUR)
    const monitor = new KlineMonitor({ adapters, dataDir })
    expect(await backfillOnly(monitor, 'garbage', undefined)).toEqual([])
  })

  it('end to end: subscribing writes history and then goes live without replaying it', async () => {
    const lastOpen = 50 * HOUR
    const { adapters } = makeAdapters(lastOpen)
    const monitor = new KlineMonitor({ adapters, dataDir }, { backfillBars: 4, pollIntervalMs: 5_000 })

    monitor.subscribe(KEY)
    await waitFor(() => readRecords().length >= 4)
    const afterBackfill = readRecords()
    expect(afterBackfill).toHaveLength(4)

    // The live loop seeds its watermark from storage, so the bar the backfill
    // already wrote is not appended a second time.
    await new Promise(r => setTimeout(r, 150))
    expect(readRecords()).toHaveLength(4)
    monitor.unsubscribe(KEY)
  })
})
