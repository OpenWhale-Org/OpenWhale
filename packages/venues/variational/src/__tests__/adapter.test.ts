import { describe, it, expect, vi } from 'vitest'
import { isTerminalError } from '@openwhaleorg/core'
import { VariationalAdapter, perIntervalRate, nextSettlement, ladderBook, type VariationalStats } from '../adapter.js'
import { variationalPlugin } from '../plugin.js'

// Shapes as /metadata/stats returned them on 2026-09-17.
const STATS: VariationalStats = {
  total_volume_24h: '2091661692.95', open_interest: '1757780568.55', num_markets: 3,
  listings: [
    {
      ticker: 'BTC', name: 'Bitcoin', mark_price: '76539.7047435865', volume_24h: '278393182.057643',
      open_interest: { long_open_interest: '117307206.83', short_open_interest: '62963694.71' },
      funding_rate: '0.046465', funding_interval_s: 28800, base_spread_bps: '1.08',
      quotes: {
        updated_at: '2026-09-17T09:14:13.042327022Z',
        base: { bid: '76597.64', ask: '76605.93' },
        size_1k: { bid: '76597.47', ask: '76606.1' },
        size_100k: { bid: '76593.87', ask: '76609.7' },
        size_1m: { bid: '76580.15', ask: '76623.43' },
      },
    },
    {
      // No $1m tier on smaller markets.
      ticker: 'NVDA', name: 'NVIDIA Corporation', mark_price: '217.3956485899133', volume_24h: '1562279.472641',
      open_interest: { long_open_interest: '2097858.05', short_open_interest: '752896.32' },
      funding_rate: '0.058514', funding_interval_s: 28800, base_spread_bps: '5.61',
      quotes: {
        updated_at: '2026-09-17T09:14:19.269579383Z',
        base: { bid: '217.401', ask: '217.523' },
        size_1k: { bid: '217.401', ask: '217.523' },
        size_100k: { bid: '217.387', ask: '217.58' },
      },
    },
    {
      // Interval 0: a synthetic product that does not settle funding.
      ticker: 'XAUS', name: 'Gold synthetic', mark_price: '3600', volume_24h: '100',
      open_interest: { long_open_interest: '0', short_open_interest: '0' },
      funding_rate: '0.1095', funding_interval_s: 0, base_spread_bps: '3',
      quotes: { updated_at: '2026-09-17T09:14:00Z', base: { bid: '3599', ask: '3601' } },
    },
  ],
}

function adapter(respond: () => Response = () => new Response(JSON.stringify(STATS))) {
  const fetch = vi.fn(async () => respond())
  return { a: new VariationalAdapter({ fetch: fetch as unknown as typeof globalThis.fetch }), fetch }
}

describe('Variational market data', () => {
  it('lists every market as a USDC-settled perp', async () => {
    const markets = await adapter().a.fetchMarkets()
    expect(markets.map(m => m.symbol)).toEqual(['BTC/USDC:USDC', 'NVDA/USDC:USDC', 'XAUS/USDC:USDC'])
    expect(markets[0]).toMatchObject({ base: 'BTC', quote: 'USDC', settle: 'USDC', type: 'swap', active: true })
  })

  it('a ticker carries the quote time, not the time it was read', async () => {
    const t = await adapter().a.fetchTicker('BTC/USDC:USDC')
    expect(t).toMatchObject({ bid: 76597.64, ask: 76605.93, last: 76539.7047435865 })
    expect(t.timestamp).toBe(Date.parse('2026-09-17T09:14:13.042Z'))
    expect(t.quoteVolume).toBeCloseTo(278393182.057643, 3)
  })

  it('turns the annualized funding rate into the rate paid per settlement', async () => {
    // The venue's base interest, 0.00125%/h, is published as 0.1095 a year.
    expect(perIntervalRate(0.1095, 3_600)).toBeCloseTo(0.0000125, 12)
    const rates = await adapter().a.fetchFundingRates()
    expect(rates.map(r => r.symbol)).toEqual(['BTC/USDC:USDC', 'NVDA/USDC:USDC'])   // no-funding product left out
    expect(rates[0]!.fundingRate).toBeCloseTo(0.046465 * 8 / 8760, 12)
    expect(rates[0]!.intervalHours).toBe(8)
    expect(rates[0]!.nextFundingTimestamp % (8 * 3_600_000)).toBe(0)
    expect(await adapter().a.fetchFundingIntervals()).toEqual({ 'BTC/USDC:USDC': 8, 'NVDA/USDC:USDC': 8 })
  })

  it('settles on the next UTC multiple of the period', () => {
    const t = Date.parse('2026-09-17T09:14:00Z')
    expect(new Date(nextSettlement(t, 28_800)).toISOString()).toBe('2026-09-17T16:00:00.000Z')
    expect(new Date(nextSettlement(t, 3_600)).toISOString()).toBe('2026-09-17T10:00:00.000Z')
  })

  it('builds a book from the size tiers, each tier the chunk up to its size', async () => {
    const book = ladderBook(STATS.listings[0]!)
    expect(book.bids.map(([p]) => p)).toEqual([76597.64, 76593.87, 76580.15])
    expect(book.bids[0]![1] * 76597.64).toBeCloseTo(1_000, 6)
    expect(book.bids[1]![1] * 76593.87).toBeCloseTo(99_000, 6)
    expect(book.asks[2]![1] * 76623.43).toBeCloseTo(900_000, 6)
    // A market without the $1m tier has two levels.
    expect(ladderBook(STATS.listings[1]!).asks).toHaveLength(2)
    const depth1 = await adapter().a.fetchOrderBook('BTC/USDC:USDC', 1)
    expect(depth1.bids).toHaveLength(1)
  })

  it('open interest is both sides, in dollars as reported', async () => {
    const oi = await adapter().a.fetchOpenInterest('BTC/USDC:USDC')
    expect(oi.value).toBeCloseTo(117307206.83 + 62963694.71, 2)
    expect(oi.amount).toBeCloseTo(oi.value! / 76539.7047435865, 6)
  })

  it('one request serves many calls, and a refused poll falls back to the last copy', async () => {
    let fail = false
    const { a, fetch } = adapter(() => (fail ? new Response('slow down', { status: 429 }) : new Response(JSON.stringify(STATS))))
    await Promise.all([a.fetchTicker('BTC/USDC:USDC'), a.fetchFundingRates(), a.fetchMarkets()])
    expect(fetch).toHaveBeenCalledTimes(1)

    const stale = new VariationalAdapter({ fetch: fetch as never, minIntervalMs: 0 })
    await stale.fetchTicker('BTC/USDC:USDC')
    fail = true
    await expect(stale.fetchTicker('NVDA/USDC:USDC')).resolves.toMatchObject({ bid: 217.401 })

    const cold = new VariationalAdapter({ fetch: fetch as never, minIntervalMs: 0 })
    await expect(cold.fetchTicker('BTC/USDC:USDC')).rejects.toThrow(/429/)
  })

  it('an unknown market is a terminal error', async () => {
    const err = await adapter().a.fetchTicker('NOPE/USDC:USDC').catch((e: unknown) => e)
    expect(isTerminalError(err)).toBe(true)
  })
})

describe('Variational trading', () => {
  it('refuses account and order calls by name, terminally', async () => {
    const { a, fetch } = adapter()
    for (const call of [
      () => a.fetchBalance(),
      () => a.fetchPositions(),
      () => a.createOrder({ symbol: 'BTC/USDC:USDC', side: 'buy', type: 'market', amount: 0.01 }),
      () => a.setLeverage('BTC/USDC:USDC', 5),
    ]) {
      const err = await call().catch((e: unknown) => e)
      expect(isTerminalError(err)).toBe(true)
      expect(String(err)).toMatch(/no public trading or account API/)
    }
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('plugin', () => {
  it('registers one keyless perp cell and no credential type', async () => {
    const plugin = variationalPlugin({} as never) as unknown as {
      name: string
      adapters?: Array<{ kind: string; type?: string; credentialTypes?: string[]; create: () => unknown }>
      credentialTypes?: unknown[]
    }
    expect(plugin.name).toBe('variational')
    expect(plugin.credentialTypes ?? []).toHaveLength(0)
    expect(plugin.adapters).toHaveLength(1)
    expect(plugin.adapters![0]!.kind).toBe('exchange/perp')
    expect(plugin.adapters![0]!.create()).toBeInstanceOf(VariationalAdapter)
  })
})
