import { describe, expect, it } from 'vitest'
import { aggregateAccountEquity } from '../aggregateAccountEquity.js'

describe('aggregateAccountEquity', () => {
  it('uses the latest real sample from every account in each bucket', () => {
    const result = aggregateAccountEquity({
      from: 0,
      to: 3_000,
      bucketMs: 1_000,
      expectedAccounts: ['beta', 'alpha'],
      recordsByAccount: {
        alpha: [
          { account: 'alpha', ts: 100, equity: 100, available: 70, unrealizedPnl: 5 },
          { account: 'alpha', ts: 900, equity: 110, available: 75, unrealizedPnl: 6 },
          { account: 'alpha', ts: 1_200, equity: 120, available: 80, unrealizedPnl: 7 },
        ],
        beta: [
          { account: 'beta', ts: 800, equity: 200, available: 150, unrealizedPnl: -2 },
          { account: 'beta', ts: 1_300, equity: 220, available: 165, unrealizedPnl: -1 },
        ],
      },
    })

    expect(result.expectedAccounts).toEqual(['alpha', 'beta'])
    expect(result.points).toEqual([
      {
        ts: 900,
        equity: 310,
        available: 225,
        unrealizedPnl: 4,
        accountCount: 2,
        expectedAccountCount: 2,
        missingAccounts: [],
      },
      {
        ts: 1_300,
        equity: 340,
        available: 245,
        unrealizedPnl: 6,
        accountCount: 2,
        expectedAccountCount: 2,
        missingAccounts: [],
      },
    ])
  })

  it('keeps missing accounts explicit and does not forward-fill them', () => {
    const result = aggregateAccountEquity({
      from: 0,
      to: 2_000,
      bucketMs: 1_000,
      expectedAccounts: ['alpha', 'beta'],
      recordsByAccount: {
        alpha: [{ account: 'alpha', ts: 1_100, equity: 120, available: 80 }],
        beta: [{ account: 'beta', ts: 100, equity: 200, unrealizedPnl: 3 }],
      },
    })

    expect(result.points).toEqual([
      {
        ts: 100,
        equity: 200,
        unrealizedPnl: 3,
        accountCount: 1,
        expectedAccountCount: 2,
        missingAccounts: ['alpha'],
      },
      {
        ts: 1_100,
        equity: 120,
        available: 80,
        accountCount: 1,
        expectedAccountCount: 2,
        missingAccounts: ['beta'],
      },
    ])
  })

  it('ignores invalid and out-of-range samples', () => {
    const result = aggregateAccountEquity({
      from: 1_000,
      to: 2_000,
      bucketMs: 1_000,
      expectedAccounts: ['alpha'],
      recordsByAccount: {
        alpha: [
          { account: 'alpha', ts: 999, equity: 1 },
          { account: 'alpha', ts: 1_500, equity: Number.NaN },
          { account: 'alpha', ts: 2_001, equity: 3 },
        ],
      },
    })

    expect(result.points).toEqual([])
  })
})
