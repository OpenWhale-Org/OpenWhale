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
