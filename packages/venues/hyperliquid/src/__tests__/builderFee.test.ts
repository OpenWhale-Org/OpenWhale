import { describe, it, expect } from 'vitest'
import {
  HyperliquidAdapter, refuseOrderBuilderOverride,
  BUILDER_ADDRESS, BUILDER_TENTHS_BP, BUILDER_MAX_FEE_RATE,
} from '../adapter.js'
import { buildHyperliquidAdapter, hyperliquidCredentialSchema } from '../plugin.js'

/**
 * The builder rate, and the approval that has to cover it.
 *
 * Hyperliquid rejects every order whose `f` exceeds the ceiling the trader
 * signed, so the rate and the approval cannot be configured apart — the
 * ceiling is derived. The first test is the one that matters most: a program
 * that configures nothing must produce byte-for-byte what the hardcoded
 * constant produced, because every live account is that program.
 */

const options = (a: HyperliquidAdapter) =>
  (a as unknown as { exchange: { options: Record<string, unknown> } }).exchange.options

const wallet = '0x' + '1'.repeat(40)

describe('builder rate and its approval ceiling', () => {
  it('a credential that configures nothing is unchanged, down to the string', () => {
    const o = options(new HyperliquidAdapter({ walletAddress: wallet }))
    expect(o['builderFee']).toBe(true)
    expect(o['builder']).toBe(BUILDER_ADDRESS)
    expect(o['feeInt']).toBe(BUILDER_TENTHS_BP)
    // Derived, and it must land on the literal the constant holds.
    expect(o['feeRate']).toBe(BUILDER_MAX_FEE_RATE)
    expect(o['feeRate']).toBe('0.01%')
  })

  it('the ceiling follows the rate', () => {
    // 50 tenths of a basis point = 5bp = 0.05%.
    const o = options(new HyperliquidAdapter({ walletAddress: wallet, builderFeeTenthsBp: 50 }))
    expect(o['feeInt']).toBe(50)
    expect(o['feeRate']).toBe('0.05%')

    for (const [tenths, rate] of [[1, '0.001%'], [10, '0.01%'], [25, '0.025%'], [100, '0.1%']] as const) {
      expect(options(new HyperliquidAdapter({ walletAddress: wallet, builderFeeTenthsBp: tenths }))['feeRate']).toBe(rate)
    }
  })

  it('a rate never exceeds the ceiling it was approved under', () => {
    // The property the venue enforces: f/1000 %  <=  feeRate.
    for (const tenths of [1, 7, 10, 33, 50, 99, 100]) {
      const o = options(new HyperliquidAdapter({ walletAddress: wallet, builderFeeTenthsBp: tenths }))
      const ceiling = Number(String(o['feeRate']).replace('%', ''))
      expect(Number(o['feeInt']) * 0.001).toBeLessThanOrEqual(ceiling)
    }
  })

  it('address and rate move independently, and false turns the whole thing off', () => {
    const other = '0xA9300365e8F6D0112A756C98F9acFC3543B295C0'
    const o = options(new HyperliquidAdapter({ walletAddress: wallet, builder: other, builderFeeTenthsBp: 50 }))
    expect(o['builder']).toBe(other)
    expect(o['feeInt']).toBe(50)

    const off = options(new HyperliquidAdapter({ walletAddress: wallet, builder: false, builderFeeTenthsBp: 50 }))
    expect(off['builderFee']).toBe(false)
    // Nothing is carried when it is off — ccxt would otherwise apply its own.
    expect(off['feeInt']).toBeUndefined()
  })
})

describe('credential data reaches the adapter', () => {
  it('reads builderAddress and builderFeeBp when the data carries them', () => {
    const o = options(buildHyperliquidAdapter({
      walletAddress: wallet, testnet: false,
      builderAddress: '0xA9300365e8F6D0112A756C98F9acFC3543B295C0', builderFeeBp: 5,
    }))
    expect(o['builder']).toBe('0xA9300365e8F6D0112A756C98F9acFC3543B295C0')
    // 5bp entered by a human is 50 tenths on the wire.
    expect(o['feeInt']).toBe(50)
    expect(o['feeRate']).toBe('0.05%')
  })

  it('data without those fields is the default program', () => {
    for (const extra of [{}, { builderAddress: '' }, { builderFeeBp: '' }, { builderFeeBp: null }]) {
      const o = options(buildHyperliquidAdapter({ walletAddress: wallet, testnet: false, ...extra }))
      expect(o['builder']).toBe(BUILDER_ADDRESS)
      expect(o['feeInt']).toBe(BUILDER_TENTHS_BP)
    }
  })

  it('the exported schema is the one the credential type uses', () => {
    const parsed = hyperliquidCredentialSchema.parse({ walletAddress: wallet })
    expect(parsed).toEqual({ walletAddress: wallet, testnet: false })
    // And it strips what it does not declare — which is why a plugin that
    // wants builder fields has to extend it rather than just store them.
    expect(hyperliquidCredentialSchema.parse({ walletAddress: wallet, builderAddress: '0xabc' }))
      .not.toHaveProperty('builderAddress')
  })
})

describe('per-order override', () => {
  it('is refused by name rather than ignored', () => {
    for (const key of ['builder', 'builderFee', 'builderFeeTenthsBp', 'builderAddress']) {
      expect(() => refuseOrderBuilderOverride({
        symbol: 'BTC/USDC:USDC', side: 'buy', type: 'market', amount: 1, params: { [key]: 50 },
      })).toThrow(/not implemented/)
    }
  })

  it('leaves every other passthrough param alone', () => {
    expect(() => refuseOrderBuilderOverride({
      symbol: 'BTC/USDC:USDC', side: 'buy', type: 'market', amount: 1,
      params: { priorityBps: 3, vaultAddress: '0x1' },
    })).not.toThrow()
    expect(() => refuseOrderBuilderOverride({ symbol: 'BTC/USDC:USDC', side: 'buy', type: 'market', amount: 1 })).not.toThrow()
  })
})
