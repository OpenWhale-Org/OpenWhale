import { describe, it, expect, vi } from 'vitest'
import { HyperliquidAdapter } from '../adapter.js'

/**
 * Two legs, one account, one instant.
 *
 * `clearinghouse` de-duplicates a position read by (account, dex) so that a
 * two-leg strategy does not ask the venue the same question twice in the same
 * millisecond. The shared answer therefore has to be true for whoever else
 * arrives — and it was not: the closure carried the FIRST caller's symbol
 * filter, so the second caller received a list already narrowed to contracts
 * it had not asked about, narrowed it again to its own, and came back empty.
 *
 * What that looked like in production (2026-09-24): a reduce script on an
 * account holding BTC long and ETH short inspected both legs at once and
 * refused, saying the BTC position did not exist. It did; the picker beside
 * the button was listing it.
 */

const wallet = '0x' + '1'.repeat(40)

describe('concurrent position reads on one account', () => {
  it('a second caller is not served the first caller\'s filter', async () => {
    const a = new HyperliquidAdapter({ walletAddress: wallet })
    const inner = vi.fn(async () => [
      { symbol: 'BTC/USDC:USDC', side: 'long', contracts: 1 },
      { symbol: 'ETH/USDC:USDC', side: 'short', contracts: 2 },
    ])
    // Stand in for everything below the sharing layer: loadMarkets, the dex
    // roster, and the ccxt read itself.
    const priv = a as unknown as Record<string, unknown>
    ;(a as unknown as { exchange: Record<string, unknown> }).exchange['loadMarkets'] = async () => ({})
    priv['hip3DexOf'] = () => undefined
    priv['listHip3Dexes'] = async () => []
    Object.defineProperty(Object.getPrototypeOf(Object.getPrototypeOf(a)), 'fetchPositions', {
      configurable: true, writable: true, value: inner,
    })

    const [btc, eth] = await Promise.all([
      a.fetchPositions(['BTC/USDC:USDC']),
      a.fetchPositions(['ETH/USDC:USDC']),
    ])

    expect(btc.map(p => p.symbol)).toEqual(['BTC/USDC:USDC'])
    expect(eth.map(p => p.symbol)).toEqual(['ETH/USDC:USDC'])
    // Still de-duplicated: the point of sharing is one request, not two.
    expect(inner).toHaveBeenCalledTimes(1)
    // And it asked the venue for everything, which is what makes it shareable.
    expect(inner).toHaveBeenCalledWith()
  })
})
