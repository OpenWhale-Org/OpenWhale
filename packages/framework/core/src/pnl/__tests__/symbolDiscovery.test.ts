import { describe, it, expect } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService } from '../PnlService.js'

/**
 * What an ACCOUNT traded is more than what OpenWhale placed.
 *
 * Binance serves trade history one symbol at a time, so the collector works
 * from a symbol list. Claims alone made that list, and a position opened by
 * hand on any other contract never entered the ledger — observed 2026-09-18
 * on a fresh account, whose history was missing every manual trade. Older
 * accounts looked complete only because a bot had already traded nearly
 * every contract their operator touched.
 */

async function db(): Promise<SQLiteAdapter> {
  const d = new SQLiteAdapter({ filePath: ':memory:' })
  await d.initialize()
  await d.run(
    `INSERT INTO pnl_order_claims (account, order_id, instance_id, symbol, ts) VALUES ('acct', 'o1', 'inst', 'CLAIMED/USDT:USDT', ?)`,
    [Date.now()])
  return d
}

describe('symbol discovery', () => {
  it('reads the contracts the venue says the account traded, and what it holds now', async () => {
    const d = await db()
    const asked: string[] = []
    const svc = new PnlService({
      db: d,
      resolveSession: async () => ({
        fetchFills: async (symbol: string) => { asked.push(symbol); return [] },
        // The income ledger names a contract traded by hand and already closed.
        fetchTradedSymbols: async () => ['PENDLE/USDT:USDT'],
        // And one still open.
        fetchPositions: async () => [{ symbol: 'AAVE/USDC:USDC', markPrice: 300 }],
      }) as never,
    })

    await svc.collect()
    expect(asked.sort()).toEqual(['AAVE/USDC:USDC', 'PENDLE/USDT:USDT', 'CLAIMED/USDT:USDT'])

    // Remembered: the next sweep reads them even when the venue reports neither.
    const quiet = new PnlService({
      db: d,
      resolveSession: async () => ({
        fetchFills: async (symbol: string) => { asked.push(symbol); return [] },
        fetchTradedSymbols: async () => [],
        fetchPositions: async () => [],
      }) as never,
    })
    asked.length = 0
    await quiet.collect()
    expect(asked.sort()).toEqual(['AAVE/USDC:USDC', 'PENDLE/USDT:USDT', 'CLAIMED/USDT:USDT'])
    expect((await d.all<{ symbol: string; source: string }>(`SELECT symbol, source FROM pnl_symbols ORDER BY symbol`)))
      .toEqual([
        { symbol: 'AAVE/USDC:USDC', source: 'position' },
        { symbol: 'PENDLE/USDT:USDT', source: 'ledger' },
      ])
  })

  it('a venue that cannot discover, or one that fails at it, still reads its claims', async () => {
    const d = await db()
    const asked: string[] = []
    const svc = new PnlService({
      db: d,
      resolveSession: async () => ({
        fetchFills: async (symbol: string) => { asked.push(symbol); return [] },
        fetchTradedSymbols: async () => { throw new Error('no ledger here') },
        fetchPositions: async () => { throw new Error('venue down') },
      }) as never,
    })
    await svc.collect()
    expect(asked).toEqual(['CLAIMED/USDT:USDT'])
  })
})
