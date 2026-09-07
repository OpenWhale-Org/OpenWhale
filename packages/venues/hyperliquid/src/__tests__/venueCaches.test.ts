import { describe, it, expect, vi, beforeEach } from 'vitest'
import { HyperliquidAdapter } from '../adapter.js'

/**
 * The funding table describes the VENUE, not a credential — but this engine
 * holds one adapter per account plus a keyless one, and each used to fetch it
 * for itself. On Hyperliquid that read fans out over every HIP-3 dex at weight
 * 20 apiece, so one invocation is ~220 of an IP budget of 1200 a minute.
 *
 * Measured 2026-09-02 before this cache: metaAndAssetCtxs ×62 a minute = 1240
 * weight, 91% of everything the process spent on the venue, while the orders it
 * exists to place cost 1 each. Executions failed on 429s raised by reads that
 * had nothing to do with them.
 */

function adapterWith(counters: { funding: number; dexes: number }) {
  const a = new HyperliquidAdapter({ walletAddress: '0x' + '1'.repeat(40) })
  const ex = (a as unknown as { exchange: Record<string, unknown> }).exchange
  ex['loadMarkets'] = async () => ({})
  ex['fetchFundingRates'] = async () => { counters.funding++; return {} }
  ex['publicPostInfo'] = async () => { counters.dexes++; return [{ name: 'xyz' }] }
  return a
}

describe('venue-global caches', () => {
  beforeEach(() => { vi.useRealTimers() })

  it('asks the venue once however many adapters ask', async () => {
    const counters = { funding: 0, dexes: 0 }
    const a = adapterWith(counters), b = adapterWith(counters), c = adapterWith(counters)
    await Promise.all([a.fetchFundingRates(), b.fetchFundingRates(), c.fetchFundingRates()])
    const dexesAfterFirst = counters.dexes
    await a.fetchFundingRates()
    await b.fetchFundingRates()

    // The fan-out is one main call plus one per dex; what matters is that three
    // adapters did not each pay for their own.
    expect(counters.dexes).toBe(dexesAfterFirst)
    expect(counters.funding).toBeLessThanOrEqual(2)
  })

  it('serves the last good table when a refresh fails — a rate limit is when it is needed most', async () => {
    const counters = { funding: 0, dexes: 0 }
    const a = adapterWith(counters)
    const first = await a.fetchFundingRates()
    const ex = (a as unknown as { exchange: Record<string, unknown> }).exchange
    ex['fetchFundingRates'] = async () => { throw new Error('429 Too Many Requests') }

    vi.useFakeTimers()
    vi.advanceTimersByTime(31_000)   // past the TTL, so a refresh is attempted
    vi.useRealTimers()

    await expect(a.fetchFundingRates()).resolves.toEqual(first)
  })
})

/**
 * ccxt builds `fetchTicker` out of `fetchTickers`, which rebuilds the market map
 * first — on Hyperliquid that walks every HIP-3 dex at weight 20 apiece: 13
 * requests and ~260 weight for one price, on every call, cache or no cache.
 * Read at trigger rate it is the IP budget several times over, which is what
 * left /info answering 429 all day while orders queued behind the reads.
 *
 * `allMids` answers the same question for a whole dex at weight 2.
 */
describe('ticker reads', () => {
  function tickerAdapter() {
    const calls: Array<Record<string, unknown>> = []
    const a = new HyperliquidAdapter({ walletAddress: '0x' + '2'.repeat(40) })
    const ex = (a as unknown as { exchange: Record<string, unknown> }).exchange
    ex['market'] = (symbol: string) => ({ info: { name: symbol.startsWith('XYZ-') ? `xyz:${symbol.slice(4).split('/')[0]}` : symbol.split('/')[0] } })
    ex['publicPostInfo'] = async (req: Record<string, unknown>) => {
      calls.push(req)
      return req['dex'] === 'xyz' ? { 'xyz:MU': '944.27', 'xyz:SKHY': '162.845' } : { BTC: '77415.5' }
    }
    return { adapter: a, calls }
  }

  it('asks allMids once per dex, not the market map per call', async () => {
    const { adapter, calls } = tickerAdapter()
    const mu = await adapter.fetchTicker('XYZ-MU/USDC:USDC')
    const skhy = await adapter.fetchTicker('XYZ-SKHY/USDC:USDC')

    expect(mu.last).toBe(944.27)
    expect(skhy.last).toBe(162.845)
    // Two symbols on one dex, one request — and it is the cheap endpoint.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ type: 'allMids', dex: 'xyz' })
  })

  it('leaves bid and ask at zero rather than inventing a spread from a mid', async () => {
    const { adapter } = tickerAdapter()
    const t = await adapter.fetchTicker('XYZ-MU/USDC:USDC')
    expect(t.bid).toBe(0)
    expect(t.ask).toBe(0)
    expect(t.last).toBeGreaterThan(0)
  })
})

/**
 * Position reads: shared while in flight, never stale, never silently flat.
 *
 * Measured 2026-09-03: a two-leg strategy on one account reconciled both legs
 * at once, sending two identical clearinghouseState requests in the same
 * millisecond, and a 429 on the xyz dex was swallowed into an empty list —
 * the account read as flat while holding two XYZ legs.
 */
describe('position reads', () => {
  function positionsAdapter(counters: { main: number; xyz: number }, opts: { failXyz?: boolean } = {}) {
    const a = new HyperliquidAdapter({ walletAddress: '0x' + '1'.repeat(40) })
    const ex = (a as unknown as { exchange: Record<string, unknown> }).exchange
    ex['loadMarkets'] = async () => ({})
    ex['markets'] = { 'XYZ-MU/USDC:USDC': { info: { name: 'xyz:MU' } }, 'BTC/USDC:USDC': { info: { name: 'BTC' } } }
    ex['market'] = (symbol: string) => (ex['markets'] as Record<string, unknown>)[symbol]
    ex['fetchPositions'] = async (_s: unknown, params?: { dex?: string }) => {
      await new Promise(r => setTimeout(r, 5))
      if (params?.dex === 'xyz') {
        counters.xyz++
        if (opts.failXyz) throw new Error('hyperliquid POST /info 429 Too Many Requests')
        return [{ symbol: 'XYZ-MU/USDC:USDC', contracts: 1, side: 'short', info: {} }]
      }
      counters.main++
      return []
    }
    return a
  }

  it('shares one in-flight read between callers that arrive together', async () => {
    const counters = { main: 0, xyz: 0 }
    const a = positionsAdapter(counters)
    await Promise.all([a.fetchPositions(['XYZ-MU/USDC:USDC']), a.fetchPositions(['XYZ-MU/USDC:USDC'])])
    expect(counters.xyz).toBe(1)
    // Sequential callers are not served from the past.
    await a.fetchPositions(['XYZ-MU/USDC:USDC'])
    expect(counters.xyz).toBe(2)
  })

  it('fails the read when a dex read fails, rather than reporting the account flat', async () => {
    const counters = { main: 0, xyz: 0 }
    const a = positionsAdapter(counters, { failXyz: true })
    await expect(a.fetchPositions(['XYZ-MU/USDC:USDC'])).rejects.toThrow(/429/)
  })
})
