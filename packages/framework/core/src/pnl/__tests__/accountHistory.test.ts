import { describe, it, expect } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService, inferHedgeSide } from '../PnlService.js'
import { attachFunding, replayPositions, toOrderRow, type LedgerFill } from '../accountHistory.js'

let n = 0
function fill(p: Partial<LedgerFill> & { side: 'buy' | 'sell'; qty: number; price: number; ts: number }): LedgerFill {
  n++
  return {
    fillId: `f${n}`, orderId: p.orderId ?? `o${n}`, instanceId: p.instanceId ?? null, symbol: p.symbol ?? 'X',
    positionSide: p.positionSide ?? null, realizedPnl: p.realizedPnl ?? 0, fee: p.fee ?? 0, feeAsset: p.feeAsset ?? 'USDT',
    ...p,
  }
}

describe('replayPositions', () => {
  it('opens, adds, reduces and closes one position flat to flat', () => {
    const rows = replayPositions('X', null, [
      fill({ side: 'buy', qty: 1, price: 100, ts: 1, fee: 0.05 }),
      fill({ side: 'buy', qty: 1, price: 110, ts: 2, fee: 0.05 }),
      fill({ side: 'sell', qty: 1.5, price: 120, ts: 3, fee: 0.09, realizedPnl: 22.5 }),
      fill({ side: 'sell', qty: 0.5, price: 90, ts: 4, fee: 0.02, realizedPnl: -7.5 }),
    ])
    expect(rows).toHaveLength(1)
    const p = rows[0]!
    expect(p).toMatchObject({ side: 'long', openTs: 1, closeTs: 4, maxQty: 2, avgEntry: 105, fills: 4, orders: 4, openQty: 0, partial: false })
    expect(p.avgExit).toBeCloseTo((1.5 * 120 + 0.5 * 90) / 2, 10)
    expect(p.volume).toBeCloseTo(100 + 110 + 180 + 45, 10)
    expect(p.fees).toBeCloseTo(0.21, 10)
    expect(p.realized).toBeCloseTo(15, 10)
    expect(p.feeRate).toBeCloseTo(0.21 / 435, 12)
    expect(p.maxNotional).toBeCloseTo(210, 10)
  })

  it('a fill crossing flat closes one position and opens the reverse, fee split by size', () => {
    const rows = replayPositions('X', null, [
      fill({ side: 'buy', qty: 1, price: 100, ts: 1 }),
      fill({ side: 'sell', qty: 3, price: 100, ts: 2, fee: 0.3, realizedPnl: 0 }),
      fill({ side: 'buy', qty: 2, price: 100, ts: 3 }),
    ])
    expect(rows.map(r => [r.side, r.openTs, r.closeTs, r.maxQty])).toEqual([['long', 1, 2, 1], ['short', 2, 3, 2]])
    expect(rows[0]!.fees).toBeCloseTo(0.1, 10)
    expect(rows[1]!.fees).toBeCloseTo(0.2, 10)
  })

  it('an open position has no close time and reports what is still held', () => {
    const [p] = replayPositions('X', null, [
      fill({ side: 'sell', qty: 4, price: 10, ts: 1 }),
      fill({ side: 'buy', qty: 1, price: 9, ts: 2, realizedPnl: 1 }),
    ])
    expect(p).toMatchObject({ side: 'short', closeTs: null, openQty: 3, maxQty: 4 })
  })

  it('closes that realized PnL before anything opened become one partial row', () => {
    const rows = replayPositions('X', null, [
      fill({ side: 'sell', qty: 2, price: 50, ts: 1, realizedPnl: 5 }),
      fill({ side: 'sell', qty: 1, price: 51, ts: 2, realizedPnl: 3 }),
      fill({ side: 'buy', qty: 1, price: 50, ts: 3 }),
    ])
    expect(rows[0]).toMatchObject({ partial: true, side: 'long', openTs: 1, closeTs: 2, realized: 8, maxQty: 3 })
    expect(rows[1]).toMatchObject({ partial: false, side: 'long', openTs: 3, closeTs: null })
  })

  it('fees paid in BNB stay out of the USD total and out of the rate', () => {
    const [p] = replayPositions('X', null, [
      fill({ side: 'buy', qty: 1, price: 100, ts: 1, fee: 0.001, feeAsset: 'BNB' }),
      fill({ side: 'sell', qty: 1, price: 100, ts: 2, fee: 0.04 }),
    ])
    expect(p!.fees).toBeCloseTo(0.04, 10)
    expect(p!.feesOther).toEqual({ BNB: 0.001 })
    expect(p!.feeRate).toBeCloseTo(0.04 / 100, 12)
  })
})

describe('attachFunding', () => {
  it('lands on the position open at the settlement hour, even if closed moments after', () => {
    const H = 3600_000
    const rows = replayPositions('X', null, [
      fill({ side: 'buy', qty: 1, price: 1, ts: H - 10 }),
      fill({ side: 'sell', qty: 1, price: 1, ts: H + 5 }),
      fill({ side: 'buy', qty: 1, price: 1, ts: H + 10 }),
    ])
    const { unmatched } = attachFunding(rows, [
      { symbol: 'X', amount: 2, asset: 'USDT', ts: H + 30 },
      { symbol: 'X', amount: 7, asset: 'USDT', ts: 5 * 60_000 },
    ])
    expect(rows[0]!.funding).toBe(2)
    expect(rows[1]!.funding).toBe(0)
    expect(unmatched).toBe(7)
    expect(rows[0]!.net).toBe(2)
  })
})

describe('toOrderRow', () => {
  it('sums an order across its fills', () => {
    const o = toOrderRow([
      fill({ orderId: 'A', side: 'buy', qty: 1, price: 10, ts: 5, fee: 0.01 }),
      fill({ orderId: 'A', side: 'buy', qty: 3, price: 12, ts: 3, fee: 0.03 }),
    ])
    expect(o).toMatchObject({ orderId: 'A', fills: 2, qty: 4, avgPrice: 11.5, firstTs: 3, lastTs: 5 })
    expect(o.feeRate).toBeCloseTo(0.04 / 46, 12)
  })
})

const ACCT = [{ ledger: 'acct', label: 'Acct' }]

describe('PnlService account history', () => {
  async function service() {
    const db = new SQLiteAdapter({ filePath: ':memory:' })
    await db.initialize()
    const put = (id: string, order: string, side: string, qty: number, price: number, ts: number, fee: number, realized = 0, positionSide: string | null = null, asset = 'USDT') =>
      db.run(
        `INSERT INTO pnl_fills (account, fill_id, order_id, instance_id, symbol, side, qty, price, realized_pnl, fee, fee_asset, ts, position_side)
         VALUES ('acct', ?, ?, NULL, 'X', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, order, side, qty, price, realized, fee, asset, ts, positionSide])
    await put('a', 'o1', 'buy', 1, 100, 1_000, 0.05)
    await put('b', 'o1', 'buy', 1, 100, 1_001, 0.05)
    await put('c', 'o2', 'sell', 2, 110, 3_700_000, 0.1, 20)
    await put('d', 'o3', 'buy', 1, 100, 3_800_000, 0.001, 0, null, 'BNB')
    await db.run(`INSERT INTO pnl_funding (account, event_key, instance_id, symbol, amount, asset, ts) VALUES ('acct', 'e1', '', 'X', 1.5, 'USDT', 3_600_030)`)
    return { svc: new PnlService({ db, resolveSession: async () => null }), put }
  }

  it('pages fills newest first with a summary over the whole window', async () => {
    const { svc } = await service()
    const page = await svc.historyFills(ACCT, { limit: 2 })
    expect(page.rows.map(r => r.fillId)).toEqual(['d', 'c'])
    expect(page.total).toBe(4)
    expect(page.summary.fees).toBeCloseTo(0.2, 10)
    expect(page.summary.feesOther).toEqual({ BNB: 0.001 })
    expect(page.summary.feeRate).toBeCloseTo(0.2 / 420, 12)
    expect(page.summary.funding).toBe(1.5)
    expect(page.summary.net).toBeCloseTo(20 - 0.2 + 1.5, 10)
  })

  it('groups orders and counts their fills', async () => {
    const { svc } = await service()
    const page = await svc.historyOrders(ACCT, { since: 0, until: 3_750_000 })
    expect(page.total).toBe(2)
    expect(page.rows.map(r => [r.orderId, r.fills])).toEqual([['o2', 1], ['o1', 2]])
    expect(page.summary.count).toBe(2)
  })

  it('replays positions with funding, and picks up fills added later', async () => {
    const { svc, put } = await service()
    let page = await svc.historyPositions(ACCT)
    expect(page.rows.map(r => [r.side, r.closeTs])).toEqual([['long', null], ['long', 3_700_000]])
    expect(page.rows[1]!.funding).toBe(1.5)
    expect(page.rows[1]!.net).toBeCloseTo(20 - 0.2 + 1.5, 10)

    await put('e', 'o4', 'sell', 1, 105, 4_000_000, 0.05, 5)
    page = await svc.historyPositions(ACCT)
    expect(page.rows.map(r => r.closeTs)).toEqual([4_000_000, 3_700_000])
    expect(page.summary.count).toBe(2)
  })

  it('keeps hedge-mode LONG and SHORT books apart', async () => {
    const { svc, put } = await service()
    await put('s1', 's1', 'sell', 5, 100, 1_200, 0, 0, 'SHORT')
    const page = await svc.historyPositions(ACCT, { symbol: 'X' })
    expect(page.rows.find(r => r.positionSide === 'SHORT')).toMatchObject({ side: 'short', maxQty: 5, closeTs: null })
    // Once the account is known to be hedge-mode, unlabelled older fills are sided by inference.
    expect(page.rows.filter(r => r.positionSide === null)).toHaveLength(0)
    expect(page.rows.filter(r => r.positionSide === 'LONG').map(r => r.closeTs)).toEqual([null, 3_700_000])
  })

  it('a combination scope takes one side of one symbol, across accounts, labelled', async () => {
    const { svc, put } = await service()
    await put('s1', 's1', 'sell', 5, 100, 1_200, 0.5, 0, 'SHORT')
    const scope = [
      { ledger: 'acct', label: 'Acct', symbol: 'X', side: 'short' as const },
      { ledger: 'other', label: 'Other', symbol: 'X', side: '*' as const },
    ]
    const positions = await svc.historyPositions(scope)
    expect(positions.rows.map(r => [r.account, r.side, r.maxQty])).toEqual([['Acct', 'short', 5]])
    const fills = await svc.historyFills(scope)
    expect(fills.rows.map(r => [r.account, r.fillId])).toEqual([['Acct', 's1']])
    expect(fills.summary.fees).toBeCloseTo(0.5, 10)
    const orders = await svc.historyOrders(scope)
    expect(orders.total).toBe(1)
    expect(await svc.historySymbols(scope)).toEqual(['X'])
  })

  it('an instance scope keeps another strategy on the same symbol out', async () => {
    const db = new SQLiteAdapter({ filePath: ':memory:' })
    await db.initialize()
    const put = (id: string, inst: string, side: string, ts: number, realized = 0) => db.run(
      `INSERT INTO pnl_fills (account, fill_id, order_id, instance_id, symbol, side, qty, price, realized_pnl, fee, fee_asset, ts)
       VALUES ('acct', ?, ?, ?, 'X', ?, 1, 100, ?, 0.1, 'USDT', ?)`, [id, id, inst, side, realized, ts])
    await put('a1', 'A', 'buy', 1_000)
    await put('b1', 'B', 'sell', 1_100)
    await put('a2', 'A', 'sell', 1_200, 3)
    await db.run(`INSERT INTO pnl_funding (account, event_key, instance_id, symbol, amount, asset, ts) VALUES ('acct', 'e1', 'B', 'X', 9, 'USDT', 1_150)`)
    const svc = new PnlService({ db, resolveSession: async () => null })
    const scope = [{ ledger: 'acct', label: 'Acct', symbol: 'X', side: '*' as const, instanceId: 'A' }]
    const positions = await svc.historyPositions(scope)
    expect(positions.rows.map(r => [r.side, r.openTs, r.closeTs])).toEqual([['long', 1_000, 1_200]])
    const fills = await svc.historyFills(scope)
    expect(fills.rows.map(r => r.fillId)).toEqual(['a2', 'a1'])
    expect(fills.summary.funding).toBe(0)
  })

  it('infers the hedge side from side and realized PnL', () => {
    expect([
      inferHedgeSide('buy', 0), inferHedgeSide('buy', 3), inferHedgeSide('sell', 0), inferHedgeSide('sell', -2), inferHedgeSide('buy', null),
    ]).toEqual(['LONG', 'SHORT', 'SHORT', 'LONG', 'LONG'])
  })
})
