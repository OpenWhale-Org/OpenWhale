import { describe, it, expect, vi } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService } from '../PnlService.js'
import { RetryableAdapterError } from '../../types/adapter/errors.js'

/**
 * A sweep against a held venue stops; a sweep against a healthy one is paced.
 *
 * 2026-10-14: the ten-minute sweep sent ~600 userTrades in three minutes
 * straight into an IP ban, each call answered 418 and each one extending the
 * ban. The adapter now refuses such calls locally and says until when; the
 * sweep has to listen, or it is six hundred log lines and nothing learned.
 */

class Held extends RetryableAdapterError {
  constructor(readonly heldUntil: number) { super('held') }
}

async function dbWithClaims(symbols: string[]) {
  const db = new SQLiteAdapter({ filePath: ':memory:' })
  await db.initialize()
  for (const [i, symbol] of symbols.entries()) {
    await db.run(
      `INSERT INTO pnl_order_claims (account, order_id, instance_id, symbol, ts) VALUES ('acct', ?, 'inst', ?, ?)`,
      [`o${i}`, symbol, Date.now()])
  }
  return db
}

const SYMBOLS = ['A/USDT:USDT', 'B/USDT:USDT', 'C/USDT:USDT', 'D/USDT:USDT']

describe('a sweep against a held venue', () => {
  it('stops at the first held answer instead of asking every symbol', async () => {
    const db = await dbWithClaims(SYMBOLS)
    const asked: string[] = []
    const svc = new PnlService({
      db, intervalMs: 1_000,
      resolveSession: async () => ({
        fetchFills: async (symbol: string) => { asked.push(symbol); throw new Held(Date.now() + 60_000) },
      }) as never,
    })
    await svc.collect()
    expect(asked).toEqual(['A/USDT:USDT'])
  })

  it('an ordinary failure still skips just that symbol', async () => {
    const db = await dbWithClaims(SYMBOLS)
    const asked: string[] = []
    const svc = new PnlService({
      db, intervalMs: 1_000,
      resolveSession: async () => ({
        fetchFills: async (symbol: string) => { asked.push(symbol); throw new Error('timeout') },
      }) as never,
    })
    await svc.collect()
    expect(asked).toEqual(SYMBOLS)
  })
})

describe('a routine sweep is paced across the interval', () => {
  it('spaces symbol reads so the sweep fills a share of the interval, not a burst', async () => {
    vi.useFakeTimers()
    const db = await dbWithClaims(SYMBOLS)
    const at: number[] = []
    const svc = new PnlService({
      db, intervalMs: 10 * 60_000,
      resolveSession: async () => ({
        fetchFills: async () => { at.push(Date.now()); return [] },
      }) as never,
    })
    const done = svc.collect()
    await vi.advanceTimersByTimeAsync(10 * 1_000)
    await done
    // Four symbols, a 1 s cap on the gap: three gaps of one second each.
    expect(at.length).toBe(4)
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBe(1_000)
    vi.useRealTimers()
  })
})
