import { describe, it, expect } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService } from '../PnlService.js'

/**
 * The watermark must never park outside the venue's serving window.
 *
 * Binance answers fetchMyTrades for 7 days. The collector advanced its
 * watermark only on a non-empty result, so once a symbol fell past that line
 * every query started out of range, returned empty, and left the watermark
 * exactly where it was — falling further behind for ever. It never raised an
 * error, because an empty list is not an error.
 *
 * COTI sat at 2026-08-14 for eight days while its executor claimed order ids
 * every hour. Ten days of fills never reached the ledger, and every report
 * read funding with no trades against it — a losing week shown as a profit.
 */

const DAY = 24 * 3600_000

async function serviceWith(fetchFills: (symbol: string, since?: number, limit?: number) => Promise<Array<{
  id: string; orderId: string; symbol: string; side: 'buy' | 'sell'; qty: number; price: number; timestamp: number
}>>) {
  const db = new SQLiteAdapter({ filePath: ':memory:' })
  await db.initialize()
  await db.run(
    `INSERT INTO pnl_order_claims (account, order_id, instance_id, symbol, ts) VALUES ('acct', 'o1', 'inst', 'COTI/USDT:USDT', ?)`,
    [Date.now()])
  const svc = new PnlService({
    db,
    resolveSession: async () => ({ fetchFills }) as never,
  })
  return { db, svc }
}

const watermarkOf = async (db: SQLiteAdapter) =>
  (await db.get<{ ts: number }>(
    `SELECT ts FROM pnl_watermarks WHERE account = 'acct' AND scope = 'fills:COTI/USDT:USDT'`))?.ts

describe('fill collection watermark', () => {
  it('never asks for a window older than the venue serves', async () => {
    const asked: number[] = []
    const { db, svc } = await serviceWith(async (_s, since) => { asked.push(since ?? 0); return [] })
    // Park it ten days back, exactly the shape that trapped COTI.
    await db.run(
      `INSERT INTO pnl_watermarks (account, scope, ts) VALUES ('acct', 'fills:COTI/USDT:USDT', ?)`,
      [Date.now() - 10 * DAY])
    await svc.collect()
    expect(asked).toHaveLength(1)
    // Six days plus the +1 the collector adds; anything near ten would be refused.
    expect(Date.now() - asked[0]!).toBeLessThan(7 * DAY)
  })

  it('advances past an empty window, so a quiet symbol cannot fall into the trap', async () => {
    const { db, svc } = await serviceWith(async () => [])
    await db.run(
      `INSERT INTO pnl_watermarks (account, scope, ts) VALUES ('acct', 'fills:COTI/USDT:USDT', ?)`,
      [Date.now() - 3 * DAY])
    await svc.collect()
    const after = await watermarkOf(db)
    expect(after).toBeGreaterThan(Date.now() - DAY)
  })

  it('keeps an overlap rather than jumping to now — a fill can land late', async () => {
    const { db, svc } = await serviceWith(async () => [])
    await db.run(
      `INSERT INTO pnl_watermarks (account, scope, ts) VALUES ('acct', 'fills:COTI/USDT:USDT', ?)`,
      [Date.now() - 3 * DAY])
    await svc.collect()
    expect(await watermarkOf(db)).toBeLessThan(Date.now())
  })

  it('still follows the fills when there are some', async () => {
    const t = Date.now() - 3600_000
    const { db, svc } = await serviceWith(async () => [
      { id: 'f1', orderId: 'o1', symbol: 'COTI/USDT:USDT', side: 'buy', qty: 1, price: 1, timestamp: t },
    ])
    await svc.collect()
    expect(await watermarkOf(db)).toBe(t)
    const rows = await db.all<{ c: number }>(`SELECT COUNT(*) AS c FROM pnl_fills`)
    expect(rows[0]!.c).toBe(1)
  })

  it('a throwing venue leaves the watermark alone — that is a real failure, not an empty window', async () => {
    const { db, svc } = await serviceWith(async () => { throw new Error('venue down') })
    const parked = Date.now() - 3 * DAY
    await db.run(
      `INSERT INTO pnl_watermarks (account, scope, ts) VALUES ('acct', 'fills:COTI/USDT:USDT', ?)`,
      [parked])
    await svc.collect()
    expect(await watermarkOf(db)).toBe(parked)
  })
})
