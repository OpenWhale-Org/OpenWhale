import { describe, it, expect } from 'vitest'
import { HyperliquidAdapter, HIP3_DEX_LIMIT, BUILDER_ADDRESS, BUILDER_TENTHS_BP, BUILDER_MAX_FEE_RATE } from '../adapter.js'

/**
 * The HIP-3 market-map window.
 *
 * Worth testing because getting it wrong is invisible until an order is
 * placed: ccxt's default limit of 10 loads only nine builder dexes, and the
 * tenth (`io`, as of 2026-08-30) resolves nowhere — funding rates and
 * positions for its symbols still come back, because those paths query each
 * dex explicitly, but `fetchTicker`/`createOrder` on `IO-SNDK/USDC:USDC`
 * throw `does not have market symbol`.
 *
 * Everything here reads the constructed ccxt options. No network: the point
 * is what we ASK ccxt to load, and asserting it against a live perpDexs list
 * would make the suite fail on a venue deployment rather than on a bug.
 *
 * `exchange` is protected, so read it through a subclass rather than a cast —
 * the test then breaks if that field is ever renamed, which is the point.
 */
class Probe extends HyperliquidAdapter {
  opts(): Record<string, unknown> {
    return this.exchange.options as Record<string, unknown>
  }
}

/** Live `perpDexs` on 2026-08-30, minus the null main-universe entry at [0]. */
const DEXES_DEPLOYED_TODAY = 10

describe('HyperliquidAdapter — HIP-3 market loading', () => {
  it('asks ccxt for more dexes than are deployed, with headroom', () => {
    const hip3 = (new Probe().opts()['fetchMarkets'] as Record<string, unknown>)['hip3'] as { limit: number }
    // ccxt's loop is `for (i = 1; i < limit; i++)`, so a limit of N reaches
    // N-1 dexes — the off-by-one that leaves the last one unloaded.
    expect(hip3.limit - 1).toBeGreaterThan(DEXES_DEPLOYED_TODAY)
    expect(hip3.limit).toBe(HIP3_DEX_LIMIT)
  })

  it('keeps spot and swap loading alongside hip3', () => {
    // ccxt merges `options` over its describe() defaults with deepExtend, so
    // overriding fetchMarkets leaves the sibling keys — and the sibling types
    // — intact. Pinned because it is ccxt-version-dependent: were that merge
    // ever to become a shallow extend, this override would silently empty the
    // spot and swap halves of the market map, and nothing else would notice.
    const types = (new Probe().opts()['fetchMarkets'] as Record<string, unknown>)['types']
    expect(types).toEqual(['spot', 'swap', 'hip3'])
  })

  it('leaves the dex allowlist empty so the roster stays server-driven', () => {
    const hip3 = (new Probe().opts()['fetchMarkets'] as Record<string, unknown>)['hip3'] as { dexes: string[] }
    // A non-empty list makes ccxt ignore `limit` and load only those dexes,
    // which would freeze the roster at whatever was current when it was typed.
    expect(hip3.dexes).toEqual([])
  })

  it('does not disturb the builder-fee settings', () => {
    const o = new Probe().opts()
    expect(o['builderFee']).toBe(true)
    expect(o['builder']).toBe(BUILDER_ADDRESS)
    expect(o['feeInt']).toBe(BUILDER_TENTHS_BP)
    expect(o['feeRate']).toBe(BUILDER_MAX_FEE_RATE)
  })

  it('still raises the limit when the builder fee is switched off', () => {
    // The opt-out branch builds a different options object; it must not lose
    // the market window along with the fee.
    const o = new Probe({ builder: false }).opts()
    expect(o['builderFee']).toBe(false)
    expect(o['builder']).toBeUndefined()
    const hip3 = (o['fetchMarkets'] as Record<string, unknown>)['hip3'] as { limit: number }
    expect(hip3.limit).toBe(HIP3_DEX_LIMIT)
  })
})
