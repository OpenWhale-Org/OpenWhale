import { describe, it, expect, beforeEach } from 'vitest'
import { shareMarketMap, resetMarketMaps, FAILED_LOAD_HOLD_MS } from '../marketMap.js'

/**
 * One walk per venue, and a failed walk that is forgotten rather than kept.
 *
 * Measured 2026-09-03: six Hyperliquid adapters booting together walked the
 * HIP-3 dexes six times in one second (2010 weight, budget 1200), and the
 * adapters whose walk drew a 429 rethrew that 429 on every position read for
 * the life of the process — ccxt memoises the rejected loadMarkets promise.
 */

function fakeExchange(opts: { fail?: () => boolean; delayMs?: number } = {}) {
  const ex = {
    id: 'hyperliquid',
    markets: undefined as Record<string, unknown> | undefined,
    currencies: undefined as Record<string, unknown> | undefined,
    options: { marketHelperProps: ['hip3TokensByName'] } as Record<string, unknown>,
    marketsLoading: undefined as Promise<unknown> | undefined,
    walks: 0,
    setMarkets(markets: Record<string, unknown> | unknown[], currencies?: Record<string, unknown>) {
      ex.markets = markets as Record<string, unknown>
      if (currencies) ex.currencies = currencies
      return ex.markets
    },
    async loadMarkets(reload = false) {
      // ccxt's shape: memoise the promise, keep it even when it rejects.
      if (reload || !ex.marketsLoading) {
        ex.marketsLoading = (async () => {
          ex.walks++
          await new Promise(r => setTimeout(r, opts.delayMs ?? 5))
          if (opts.fail?.()) throw new Error('429 Too Many Requests')
          ex.options['hip3TokensByName'] = { MU: { dex: 'xyz' } }
          ex.currencies = { USDC: {} }
          return ex.setMarkets({ 'XYZ-MU/USDC:USDC': { id: 'xyz:MU' } }, ex.currencies)
        })()
      }
      return ex.marketsLoading as Promise<Record<string, unknown>>
    },
  }
  return shareMarketMap(ex) as typeof ex
}

describe('shared market map', () => {
  beforeEach(() => resetMarketMaps())

  it('walks once for three adapters that boot together', async () => {
    const a = fakeExchange(), b = fakeExchange(), c = fakeExchange()
    await Promise.all([a.loadMarkets(), b.loadMarkets(), c.loadMarkets()])
    expect(a.walks + b.walks + c.walks).toBe(1)
    // The sharers hold the same map and the helper tables parsers read.
    expect(Object.keys(b.markets!)).toEqual(['XYZ-MU/USDC:USDC'])
    expect(c.options['hip3TokensByName']).toEqual({ MU: { dex: 'xyz' } })
    expect(c.currencies).toEqual({ USDC: {} })
  })

  it('a later adapter takes the map without a walk', async () => {
    const a = fakeExchange()
    await a.loadMarkets()
    const b = fakeExchange()
    await b.loadMarkets()
    expect(b.walks).toBe(0)
    expect(b.markets).toBe(a.markets)
  })

  it('forgets a failed walk after the hold instead of rethrowing it forever', async () => {
    let failing = true
    const a = fakeExchange({ fail: () => failing })
    await expect(a.loadMarkets()).rejects.toThrow('429')
    // During the hold: fails fast, no second walk piled onto the venue.
    await expect(a.loadMarkets()).rejects.toThrow('429')
    expect(a.walks).toBe(1)
    failing = false
    await new Promise(r => setTimeout(r, FAILED_LOAD_HOLD_MS + 20))
    await expect(a.loadMarkets()).resolves.toBeDefined()
    expect(a.walks).toBe(2)
  }, 10_000)

  it('a failure on one adapter does not poison an adapter that asks after the hold', async () => {
    let failing = true
    const a = fakeExchange({ fail: () => failing })
    await expect(a.loadMarkets()).rejects.toThrow('429')
    failing = false
    await new Promise(r => setTimeout(r, FAILED_LOAD_HOLD_MS + 20))
    const b = fakeExchange()
    await expect(b.loadMarkets()).resolves.toBeDefined()
    expect(b.walks).toBe(1)
  }, 10_000)
})
