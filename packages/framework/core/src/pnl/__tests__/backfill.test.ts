import { describe, it, expect } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService, timeWindows } from '../PnlService.js'

/**
 * Deep backfill: what the venue still serves, not just the last few days.
 * Binance answers userTrades only per symbol and only 7 days at a time, so
 * "everything" means walking windows — and the walk must not skip a contract
 * merely because OpenWhale never placed an order on it.
 */

const DAY = 24 * 3600_000

describe('timeWindows', () => {
  it('covers the span oldest first, never longer than one window', () => {
    expect(timeWindows(0, 25, 10)).toEqual([[0, 10], [10, 20], [20, 25]])
    expect(timeWindows(5, 5, 10)).toEqual([])
  })
})

describe('backfillAccount', () => {
  async function setup(fills: Record<string, Array<{ id: string; ts: number }>>, ledgerSymbols: string[]) {
    const db = new SQLiteAdapter({ filePath: ':memory:' })
    await db.initialize()
    const asked: Array<{ symbol: string; since: number; until: number }> = []
    const session = {
      // The income ledger names the contract in whichever window it traded.
      fetchTradedSymbols: async () => ledgerSymbols,
      fetchFills: async (symbol: string, since?: number, _limit?: number, until?: number) => {
        asked.push({ symbol, since: since ?? 0, until: until ?? 0 })
        return (fills[symbol] ?? [])
          .filter(f => f.ts >= (since ?? 0) && f.ts < (until ?? Infinity))
          .map(f => ({ id: f.id, orderId: f.id, symbol, side: 'buy', qty: 1, price: 10, fee: 0.01, feeAsset: 'USDT', timestamp: f.ts }))
      },
    }
    const svc = new PnlService({ db, resolveSession: async () => session, backfillPaceMs: 0 })
    return { svc, db, asked }
  }

  it('finds a contract nothing recorded and pulls its fills', async () => {
    const old = Date.now() - 60 * DAY
    const { svc, db } = await setup({ 'HAND/USDT:USDT': [{ id: 'h1', ts: old }, { id: 'h2', ts: old + 1000 }] }, ['HAND/USDT:USDT'])
    const report = await svc.backfillAccount('acct')

    expect(report.discovered).toBe(1)
    expect(report.symbols).toEqual([{ symbol: 'HAND/USDT:USDT', fills: 2 }])
    const rows = await db.all<{ n: number }>(`SELECT COUNT(*) AS n FROM pnl_fills WHERE account = 'acct'`)
    expect(rows[0]!.n).toBe(2)
    // The contract is remembered, so the routine sweep reads it from now on.
    const known = await db.all<{ symbol: string }>(`SELECT symbol FROM pnl_symbols WHERE account = 'acct'`)
    expect(known.map(r => r.symbol)).toEqual(['HAND/USDT:USDT'])
  })

  it('asks in windows the venue will answer, oldest first', async () => {
    const { svc, asked } = await setup({ 'HAND/USDT:USDT': [] }, ['HAND/USDT:USDT'])
    await svc.backfillAccount('acct', { from: Date.now() - 30 * DAY })

    expect(asked.length).toBeGreaterThan(4)
    expect(asked.every(a => a.until - a.since <= 7 * DAY)).toBe(true)
    expect(asked.map(a => a.since)).toEqual([...asked.map(a => a.since)].sort((x, y) => x - y))
  })

  it('a window the venue refuses marks the contract partial instead of failing the run', async () => {
    const db = new SQLiteAdapter({ filePath: ':memory:' })
    await db.initialize()
    const session = {
      fetchTradedSymbols: async () => ['BAD/USDT:USDT', 'GOOD/USDT:USDT'],
      fetchFills: async (symbol: string, since?: number) => {
        if (symbol === 'BAD/USDT:USDT') throw new Error('-1127 window too large')
        return [{ id: `g${since}`, orderId: 'o', symbol, side: 'sell', qty: 2, price: 5, timestamp: (since ?? 0) + 1 }]
      },
    }
    const svc = new PnlService({ db, resolveSession: async () => session, backfillPaceMs: 0 })
    const report = await svc.backfillAccount('acct', { from: Date.now() - 10 * DAY })

    expect(report.skipped).toEqual(['BAD/USDT:USDT'])
    expect(report.symbols.map(s => s.symbol)).toEqual(['GOOD/USDT:USDT'])
  })

  it('reports progress so a run of many contracts can be watched', async () => {
    const { svc } = await setup({ 'HAND/USDT:USDT': [] }, ['HAND/USDT:USDT'])
    const phases = new Set<string>()
    await svc.backfillAccount('acct', { from: Date.now() - 10 * DAY, onProgress: p => phases.add(p.phase) })
    expect([...phases].sort()).toEqual(['fills', 'symbols'])
  })
})
