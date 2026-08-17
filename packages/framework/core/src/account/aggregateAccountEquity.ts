import type { AccountSnapshotRecord } from '../types/account.js'

export interface CombinedAccountEquityPoint {
  ts: number
  equity: number
  accountCount: number
  expectedAccountCount: number
  missingAccounts: string[]
  available?: number
  unrealizedPnl?: number
}

export interface CombinedAccountEquitySeries {
  from: number
  to: number
  bucketMs: number
  expectedAccounts: string[]
  points: CombinedAccountEquityPoint[]
}

interface AggregateAccountEquityOptions {
  recordsByAccount: Record<string, AccountSnapshotRecord[]>
  expectedAccounts: string[]
  from: number
  to: number
  bucketMs: number
}

/**
 * Combine account snapshots into time buckets without inventing values.
 *
 * Every account contributes at most one value per bucket: its latest actual
 * sample in that bucket. Missing accounts stay explicit instead of being
 * forward-filled indefinitely, so consumers can show partial-data states.
 */
export function aggregateAccountEquity({
  recordsByAccount,
  expectedAccounts,
  from,
  to,
  bucketMs,
}: AggregateAccountEquityOptions): CombinedAccountEquitySeries {
  if (!Number.isFinite(bucketMs) || bucketMs <= 0) throw new Error('bucketMs must be positive')
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error('invalid time range')

  const accounts = Array.from(new Set(expectedAccounts)).sort()
  const buckets = new Map<number, Map<string, AccountSnapshotRecord>>()

  for (const account of accounts) {
    for (const record of recordsByAccount[account] ?? []) {
      if (record.ts < from || record.ts > to || !Number.isFinite(record.equity)) continue
      const bucket = Math.floor((record.ts - from) / bucketMs)
      const records = buckets.get(bucket) ?? new Map<string, AccountSnapshotRecord>()
      const previous = records.get(account)
      if (!previous || record.ts > previous.ts) records.set(account, record)
      buckets.set(bucket, records)
    }
  }

  const points = Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([, records]): CombinedAccountEquityPoint => {
      const samples = Array.from(records.values())
      const missingAccounts = accounts.filter(account => !records.has(account))
      const allHaveAvailable = samples.every(sample => sample.available !== undefined)
      const allHaveUnrealizedPnl = samples.every(sample => sample.unrealizedPnl !== undefined)
      return {
        ts: Math.max(...samples.map(sample => sample.ts)),
        equity: samples.reduce((sum, sample) => sum + sample.equity, 0),
        accountCount: samples.length,
        expectedAccountCount: accounts.length,
        missingAccounts,
        ...(allHaveAvailable
          ? { available: samples.reduce((sum, sample) => sum + sample.available!, 0) }
          : {}),
        ...(allHaveUnrealizedPnl
          ? { unrealizedPnl: samples.reduce((sum, sample) => sum + sample.unrealizedPnl!, 0) }
          : {}),
      }
    })

  return { from, to, bucketMs, expectedAccounts: accounts, points }
}
