import { describe, it, expect } from 'vitest'
import { fundingKey } from '../history/collect.js'

describe('fundingKey', () => {
  it('keeps hourly payments apart when the venue gives them all the same id', () => {
    // Hyperliquid: every funding entry carries the zero hash.
    const a = fundingKey({ id: '0x00', symbol: 'XYZ-NATGAS/USDC:USDC', amount: 3.15, asset: 'USDC', timestamp: 1_760_299_200_018 })
    const b = fundingKey({ id: '0x00', symbol: 'XYZ-BRENTOIL/USDC:USDC', amount: 0.42, asset: 'USDC', timestamp: 1_760_299_200_018 })
    const c = fundingKey({ id: '0x00', symbol: 'XYZ-NATGAS/USDC:USDC', amount: 3.15, asset: 'USDC', timestamp: 1_760_302_800_020 })
    expect(new Set([a, b, c]).size).toBe(3)
  })

  it('treats a repeated page row as the same payment', () => {
    const ev = { id: '91', symbol: 'SOXS/USDT:USDT', amount: -0.08, asset: 'USDT', timestamp: 1_760_299_200_000 }
    expect(fundingKey(ev)).toBe(fundingKey({ ...ev }))
  })
})
