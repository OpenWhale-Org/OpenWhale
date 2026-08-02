import { describe, it, expect } from 'vitest'
import { SpotAccount } from '../SpotAccount.js'
import { MockPerpAdapter } from '../../mock/MockPerpAdapter.js'

describe('SpotAccount', () => {
  const account = new SpotAccount('Test Main', new MockPerpAdapter())

  it('carries the serializable matching metadata', () => {
    expect(SpotAccount.kind).toBe('exchange/spot')
  })

  it('aggregates balances, pricing only stables in the usd view', async () => {
    const balance = await account.balance()
    // Mock returns 10k USDC (8k free / 2k used) — a stable, so fully priced
    expect(balance.usd.total).toBe(10_000)
    expect(balance.usd.available).toBe(8_000)
    expect(balance.tokens[0]).toMatchObject({ token: 'USDC', free: 8_000, locked: 2_000, usdValue: 10_000 })
  })

  it('summarizes open orders and closed history', async () => {
    const orders = await account.orders()
    expect(orders[0]).toMatchObject({ side: 'buy', status: 'open' })

    const history = await account.history(5)
    expect(history.length).toBeGreaterThan(0)
    expect(history[0]!.type).toBe('trade')
  })

  it('exposes NO write or perp-only surface', () => {
    const surface = account as unknown as Record<string, unknown>
    for (const forbidden of ['createOrder', 'cancelOrder', 'setLeverage', 'positions', 'fetchPositions', 'pnl', 'fetchFundingRates', 'watchTrades']) {
      expect(surface[forbidden], forbidden).toBeUndefined()
    }
  })
})
