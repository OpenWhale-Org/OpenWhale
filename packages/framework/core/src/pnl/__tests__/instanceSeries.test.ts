import { describe, it, expect, beforeEach } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService } from '../PnlService.js'

/**
 * The curve behind the number.
 *
 * Its whole value is agreeing with `instancePnl` — a chart that drifts from the
 * figure printed beside it is worse than no chart, because the reader has no
 * way to know which one lied.
 */

async function serviceWith(rows: {
  fills?: Array<{ realized: number | null; fee: number | null; ts: number }>
  funding?: Array<{ amount: number; ts: number }>
}) {
  const db = new SQLiteAdapter({ filePath: ':memory:' })
  await db.initialize()
  let n = 0
  for (const f of rows.fills ?? []) {
    n++
    await db.run(
      `INSERT INTO pnl_fills (account, fill_id, order_id, instance_id, symbol, side, qty, price, realized_pnl, fee, ts)
       VALUES ('acct', ?, ?, 'inst', 'X/USDT:USDT', 'buy', 1, 1, ?, ?, ?)`,
      [`f${n}`, `o${n}`, f.realized, f.fee, f.ts])
  }
  for (const g of rows.funding ?? []) {
    n++
    await db.run(
      `INSERT INTO pnl_funding (account, event_key, instance_id, symbol, amount, asset, ts)
       VALUES ('acct', ?, 'inst', 'X/USDT:USDT', ?, 'USDT', ?)`,
      [`e${n}`, g.amount, g.ts])
  }
  return new PnlService({ db, resolveSession: async () => null })
}

describe('instanceSeries', () => {
  it('ends on the same total instancePnl reports', async () => {
    const svc = await serviceWith({
      fills: [
        { realized: 10, fee: 0.5, ts: 1_000 },
        { realized: -4, fee: 0.25, ts: 3_000 },
      ],
      funding: [{ amount: 3.25, ts: 2_000 }],
    })
    const series = await svc.instanceSeries('inst')
    const summary = await svc.instancePnl('inst')
    expect(series.at(-1)!.value).toBeCloseTo(summary.net, 9)
    expect(series.at(-1)!.value).toBeCloseTo(10 - 0.5 - 4 - 0.25 + 3.25, 9)
  })

  it('interleaves funding with fills in time order', async () => {
    const svc = await serviceWith({
      fills: [{ realized: 10, fee: 0, ts: 1_000 }, { realized: 10, fee: 0, ts: 3_000 }],
      funding: [{ amount: 5, ts: 2_000 }],
    })
    const series = await svc.instanceSeries('inst')
    expect(series.map(p => p.ts)).toEqual([1_000, 2_000, 3_000])
    expect(series.map(p => p.value)).toEqual([10, 15, 25])
  })

  /**
   * Both columns are nullable. `realized_pnl - fee` returns NULL when either
   * is, and a NULL delta silently drops that fill from the running total —
   * the curve would then disagree with the figure beside it by exactly the
   * fills that happened to have no fee recorded.
   */
  it('treats a missing realized_pnl or fee as zero, not as a missing row', async () => {
    const svc = await serviceWith({
      fills: [
        { realized: 10, fee: null, ts: 1_000 },
        { realized: null, fee: 0.5, ts: 2_000 },
      ],
    })
    const series = await svc.instanceSeries('inst')
    expect(series).toHaveLength(2)
    expect(series.at(-1)!.value).toBeCloseTo(9.5, 9)
  })

  it('keeps the last point when downsampling, so the curve reaches the total', async () => {
    const fills = Array.from({ length: 500 }, (_, i) => ({ realized: 1, fee: 0, ts: 1_000 + i }))
    const svc = await serviceWith({ fills })
    const series = await svc.instanceSeries('inst', 20)
    expect(series.length).toBeLessThanOrEqual(21)
    expect(series.at(-1)!.value).toBe(500)
    expect(series.at(-1)!.ts).toBe(1_499)
  })

  it('returns nothing at all for an instance with no ledger', async () => {
    const svc = await serviceWith({})
    expect(await svc.instanceSeries('inst')).toEqual([])
  })
})
