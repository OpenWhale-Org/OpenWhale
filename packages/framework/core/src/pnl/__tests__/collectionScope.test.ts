import { describe, it, expect, vi } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService } from '../PnlService.js'

/**
 * What a collection COSTS, in venue requests.
 *
 * Hyperliquid allows 1200 weight a minute per IP and prices an ordinary `info`
 * call at 20, so a sweep of one account's seventeen symbols is a third of the
 * budget — and the sweep used to run on every order, because a claim's kick
 * called the collector with no scope at all. Reads and writes share one queue,
 * so that arrived as order latency: 814ms median on Hyperliquid against 11ms
 * on Binance, with tails past thirty seconds (measured 2026-09-02).
 *
 * These pin the two things that made it cheap: a claim collects what it named,
 * and a venue whose fills are account-scoped is asked once.
 */

const fill = (symbol: string, id: string, ts: number) => ({
  id, orderId: `o-${id}`, symbol, side: 'buy' as const, qty: 1, price: 100, timestamp: ts,
})

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

const SYMBOLS = ['BTC/USDC:USDC', 'ETH/USDC:USDC', 'SOL/USDC:USDC']

describe('a claim collects what it named', () => {
  it('queries only the symbol that traded, not every symbol of every account', async () => {
    vi.useFakeTimers()
    const db = await dbWithClaims(SYMBOLS)
    const asked: string[] = []
    const svc = new PnlService({
      db,
      resolveSession: async () => ({
        fetchFills: async (symbol: string) => { asked.push(symbol); return [] },
      }) as never,
    })

    await svc.recordClaim({ account: 'acct', symbol: 'ETH/USDC:USDC', orderId: 'o9', instanceId: 'inst', ts: Date.now() })
    await vi.advanceTimersByTimeAsync(31_000)
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(0))

    expect(asked).toEqual(['ETH/USDC:USDC'])
    vi.useRealTimers()
  })

  it('coalesces a burst into one pass over the symbols it touched', async () => {
    vi.useFakeTimers()
    const db = await dbWithClaims(SYMBOLS)
    const asked: string[] = []
    const svc = new PnlService({
      db,
      resolveSession: async () => ({
        fetchFills: async (symbol: string) => { asked.push(symbol); return [] },
      }) as never,
    })

    for (const symbol of ['BTC/USDC:USDC', 'ETH/USDC:USDC', 'BTC/USDC:USDC']) {
      await svc.recordClaim({ account: 'acct', symbol, orderId: `x-${symbol}-${asked.length}`, instanceId: 'inst', ts: Date.now() })
    }
    await vi.advanceTimersByTimeAsync(31_000)
    await vi.waitFor(() => expect(asked.length).toBeGreaterThan(1))

    expect([...asked].sort()).toEqual(['BTC/USDC:USDC', 'ETH/USDC:USDC'])
    vi.useRealTimers()
  })
})

describe('an account-scoped venue is asked once', () => {
  it('uses fetchFillsAll for the sweep and files every symbol it returns', async () => {
    const db = await dbWithClaims(SYMBOLS)
    let perSymbolCalls = 0, bulkCalls = 0
    const svc = new PnlService({
      db,
      resolveSession: async () => ({
        fetchFills: async () => { perSymbolCalls++; return [] },
        fetchFillsAll: async () => {
          bulkCalls++
          return [fill('BTC/USDC:USDC', 'f1', Date.now() - 1000), fill('SOL/USDC:USDC', 'f2', Date.now() - 500)]
        },
      }) as never,
    })

    await svc.collect()

    expect(bulkCalls).toBe(1)
    expect(perSymbolCalls).toBe(0)
    const rows = await db.all<{ symbol: string }>(`SELECT symbol FROM pnl_fills ORDER BY symbol`)
    expect(rows.map(r => r.symbol)).toEqual(['BTC/USDC:USDC', 'SOL/USDC:USDC'])
  })

  it('advances the watermark of a symbol the call returned nothing for', async () => {
    const db = await dbWithClaims(SYMBOLS)
    const svc = new PnlService({
      db,
      resolveSession: async () => ({
        fetchFills: async () => [],
        fetchFillsAll: async () => [fill('BTC/USDC:USDC', 'f1', Date.now() - 1000)],
      }) as never,
    })

    await svc.collect()

    // A quiet symbol must not be left parked, or it walks into the window trap.
    const quiet = await db.get<{ ts: number }>(
      `SELECT ts FROM pnl_watermarks WHERE account = 'acct' AND scope = 'fills:ETH/USDC:USDC'`)
    expect(quiet?.ts).toBeGreaterThan(Date.now() - 20 * 60_000)
  })

  /* A page that comes back full was cut by the venue. A symbol absent from it
     has not been shown to be quiet — its fills may sit past the cut — so its
     watermark may reach the page's end, never the present. Advancing it to
     "now" would step over every fill past the cut, silently: the same shape
     as the COTI loss, arriving through the bulk path instead. */
  it('pages until the venue comes back short, and files every page', async () => {
    const db = await dbWithClaims(SYMBOLS)
    const t0 = Date.now() - 3600_000
    // 2000 BTC rows, then 300 SOL rows: two pages, the second one short.
    const all = [
      ...Array.from({ length: 2000 }, (_, i) => fill('BTC/USDC:USDC', `b${i}`, t0 + i * 1000)),
      ...Array.from({ length: 300 }, (_, i) => fill('SOL/USDC:USDC', `s${i}`, t0 + 2000_000 + i * 1000)),
    ]
    const asked: number[] = []
    const svc = new PnlService({
      db,
      resolveSession: async () => ({
        fetchFills: async () => [],
        fetchFillsAll: async (since: number, limit: number) => {
          asked.push(since)
          return all.filter(f => f.timestamp >= since).slice(0, limit)
        },
      }) as never,
    })

    await svc.collect()

    expect(asked).toHaveLength(2)
    const sol = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM pnl_fills WHERE symbol = 'SOL/USDC:USDC'`)
    expect(sol?.n).toBe(300)
    // ETH never traded and the read completed: it advances like any quiet symbol.
    const eth = await db.get<{ ts: number }>(`SELECT ts FROM pnl_watermarks WHERE account = 'acct' AND scope = 'fills:ETH/USDC:USDC'`)
    expect(eth?.ts).toBeGreaterThan(t0)
  })

  it('does not advance an absent symbol past a read that stopped short', async () => {
    const db = await dbWithClaims(SYMBOLS)
    const pageEnd = Date.now() - 6 * 3600_000
    const svc = new PnlService({
      db,
      resolveSession: async () => ({
        fetchFills: async () => [],
        // Every page full, every page BTC, hours old: the venue keeps saying
        // "more" until the sweep's page bound stops the read.
        fetchFillsAll: async (since: number, limit: number) =>
          Array.from({ length: limit }, (_, i) => fill('BTC/USDC:USDC', `f${since}-${i}`, pageEnd - (limit - i) * 1000)),
      }) as never,
    })

    await svc.collect()

    const eth = await db.get<{ ts: number }>(
      `SELECT ts FROM pnl_watermarks WHERE account = 'acct' AND scope = 'fills:ETH/USDC:USDC'`)
    expect(eth?.ts).toBeLessThanOrEqual(pageEnd)
  })

  it('never moves a symbol watermark backwards on a query that started from an older one', async () => {
    const db = await dbWithClaims(SYMBOLS)
    const recent = Date.now() - 60_000
    await db.run(`INSERT INTO pnl_watermarks (account, scope, ts) VALUES ('acct', 'fills:ETH/USDC:USDC', ?)`, [recent])
    const svc = new PnlService({
      db,
      resolveSession: async () => ({
        fetchFills: async () => [],
        // ETH's row is older than ETH's own watermark: the query began from a
        // staler symbol and swept it up.
        fetchFillsAll: async () => [fill('ETH/USDC:USDC', 'old', recent - 3600_000)],
      }) as never,
    })

    await svc.collect()

    const eth = await db.get<{ ts: number }>(
      `SELECT ts FROM pnl_watermarks WHERE account = 'acct' AND scope = 'fills:ETH/USDC:USDC'`)
    expect(eth?.ts).toBeGreaterThanOrEqual(recent)
  })

  it('falls back to one query per symbol when the bulk call fails', async () => {
    const db = await dbWithClaims(SYMBOLS)
    const asked: string[] = []
    const svc = new PnlService({
      db,
      resolveSession: async () => ({
        fetchFills: async (symbol: string) => { asked.push(symbol); return [] },
        fetchFillsAll: async () => { throw new Error('429') },
      }) as never,
    })

    await svc.collect()

    expect([...asked].sort()).toEqual([...SYMBOLS].sort())
  })
})
