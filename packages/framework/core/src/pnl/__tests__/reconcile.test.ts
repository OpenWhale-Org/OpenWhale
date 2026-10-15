import { describe, it, expect } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService } from '../PnlService.js'
import { replayPositions, RECON_ORDER_ID } from '../accountHistory.js'

/**
 * The venue's position is the truth the ledger is reconstructing.
 *
 * SKUU's book carried 6.76 contracts the venue did not hold, because three
 * closing fills from 2026-09-27 never reached the ledger and Binance no
 * longer serves that week. A book that cannot read as flat never closes its
 * position row, and every later fill folds into it.
 */

const ACC = 'Binance SubAccount 2'
const MIN = 60_000
const QUIET = 11 * MIN

type Pos = { symbol: string; markPrice: number; side?: string; contracts?: number; info?: unknown }

async function setup(positions: Pos[], opts: { reconcile?: boolean } = {}) {
  const db = new SQLiteAdapter({ filePath: ':memory:' })
  await db.initialize()
  const asked: number[] = []
  const svc = new PnlService({
    db,
    reconcile: opts.reconcile ?? true,
    resolveSession: async () => ({
      fetchFills: async () => [],
      fetchPositions: async () => { asked.push(Date.now()); return positions },
    }),
  })
  return { db, svc, asked }
}

const fill = (db: SQLiteAdapter, o: { id: string; symbol: string; ps: string | null; side: string; qty: number; ts: number }) =>
  db.run(`INSERT INTO pnl_fills (account, fill_id, order_id, instance_id, symbol, side, qty, price, realized_pnl, fee, fee_asset, ts, position_side)
          VALUES (?, ?, ?, NULL, ?, ?, ?, 30.89, 0, 0.01, 'USDT', ?, ?)`,
    [ACC, o.id, `o${o.id}`, o.symbol, o.side, o.qty, o.ts, o.ps])

const claim = (db: SQLiteAdapter) =>
  db.run(`INSERT INTO pnl_order_claims (account, order_id, instance_id, symbol, executor, ts) VALUES (?, 'o1', 'inst_x', 'SKUU/USDT:USDT', NULL, 1)`, [ACC])

const recons = (db: SQLiteAdapter) =>
  db.all<{ symbol: string; side: string; qty: number; position_side: string | null; fee: number | null; realized_pnl: number | null }>(
    `SELECT symbol, side, qty, position_side, fee, realized_pnl FROM pnl_fills WHERE order_id = ? ORDER BY symbol, position_side`, [RECON_ORDER_ID])

describe('reconcileAccount', () => {
  it('closes a book the venue does not hold', async () => {
    const now = Date.now()
    const { db, svc } = await setup([])      // 交易所空仓
    await claim(db)
    // 账本以为还有 6.76 张多头：开 10、只平回 3.24
    await fill(db, { id: '1', symbol: 'SKUU/USDT:USDT', ps: 'LONG', side: 'buy', qty: 10, ts: now - QUIET - MIN })
    await fill(db, { id: '2', symbol: 'SKUU/USDT:USDT', ps: 'LONG', side: 'sell', qty: 3.24, ts: now - QUIET })
    await svc.collect()

    const rows = await recons(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ symbol: 'SKUU/USDT:USDT', position_side: 'LONG', side: 'sell' })
    expect(rows[0]!.qty).toBeCloseTo(6.76, 10)
    // 不带价格发现、不带费用：不能污染手续费率
    expect(rows[0]!.fee).toBeNull()
    expect(rows[0]!.realized_pnl).toBeNull()
  })

  it('trims a book to the size the venue actually holds', async () => {
    const now = Date.now()
    const { db, svc } = await setup([
      { symbol: 'SKUU/USDT:USDT', markPrice: 17.75, side: 'short', contracts: 7.56, info: { positionSide: 'SHORT' } },
    ])
    await claim(db)
    await fill(db, { id: '1', symbol: 'SKUU/USDT:USDT', ps: 'SHORT', side: 'sell', qty: 20, ts: now - QUIET - MIN })
    await fill(db, { id: '2', symbol: 'SKUU/USDT:USDT', ps: 'SHORT', side: 'buy', qty: 4, ts: now - QUIET })
    await svc.collect()                       // 账本 -16，交易所 -7.56 → 买回 8.44

    const rows = await recons(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ side: 'buy', position_side: 'SHORT' })
    expect(rows[0]!.qty).toBeCloseTo(8.44, 10)
  })

  it('leaves a book that agrees, and one that is still trading, alone', async () => {
    const now = Date.now()
    const { db, svc } = await setup([
      { symbol: 'KORU/USDT:USDT', markPrice: 10, side: 'long', contracts: 6, info: { positionSide: 'LONG' } },
      { symbol: 'EWY/USDT:USDT', markPrice: 150, side: 'short', contracts: 99, info: { positionSide: 'SHORT' } },
    ])
    await claim(db)
    // 一致
    await fill(db, { id: '1', symbol: 'KORU/USDT:USDT', ps: 'LONG', side: 'buy', qty: 6, ts: now - QUIET })
    // 不一致，但 1 分钟前刚成交 —— 采集器还在追这一波
    await fill(db, { id: '2', symbol: 'EWY/USDT:USDT', ps: 'SHORT', side: 'sell', qty: 40, ts: now - MIN })
    await svc.collect()

    expect(await recons(db)).toHaveLength(0)
  })

  it('writes nothing when reconciliation is off, so an install can watch first', async () => {
    const now = Date.now()
    const { db, svc } = await setup([], { reconcile: false })
    await claim(db)
    await fill(db, { id: '1', symbol: 'SKUU/USDT:USDT', ps: 'LONG', side: 'buy', qty: 10, ts: now - QUIET })
    await svc.collect()

    expect(await recons(db)).toHaveLength(0)
  })

  it('lets the position row close, without counting as traded volume', async () => {
    const now = Date.now()
    const { db, svc } = await setup([])
    await claim(db)
    await fill(db, { id: '1', symbol: 'SKUU/USDT:USDT', ps: 'LONG', side: 'buy', qty: 10, ts: now - QUIET - MIN })
    await fill(db, { id: '2', symbol: 'SKUU/USDT:USDT', ps: 'LONG', side: 'sell', qty: 3.24, ts: now - QUIET })

    const scope = [{ ledger: ACC, label: ACC, symbol: 'SKUU/USDT:USDT' }]
    const before = (await svc.historyPositions(scope)).rows
    expect(before.at(-1)!.closeTs).toBeNull()

    await svc.collect()

    const after = (await svc.historyPositions(scope)).rows
    expect(after).toHaveLength(1)
    expect(after[0]!.closeTs).not.toBeNull()
    expect(after[0]!.reconciled).toBe(true)
    expect(after[0]!.fills).toBe(2)                       // 对账行不是成交
    expect(after[0]!.volume).toBeCloseTo((10 + 3.24) * 30.89, 6)
  })
})

describe('replayPositions', () => {
  it('treats a reconciliation as quantity only', () => {
    const base = { symbol: 'SKUU/USDT:USDT', positionSide: 'LONG', instanceId: null, feeAsset: 'USDT' }
    const rows = replayPositions('SKUU/USDT:USDT', 'LONG', [
      { ...base, fillId: '1', orderId: 'o1', side: 'buy', qty: 10, price: 30, realizedPnl: 0, fee: 1, ts: 1 },
      { ...base, fillId: 'recon:9:LONG', orderId: RECON_ORDER_ID, side: 'sell', qty: 10, price: 30, realizedPnl: null, fee: null, ts: 9 },
    ] as never)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ closeTs: 9, reconciled: true, fills: 1 })
    expect(rows[0]!.volume).toBeCloseTo(300, 6)
    expect(rows[0]!.fees).toBeCloseTo(1, 6)
  })
})
