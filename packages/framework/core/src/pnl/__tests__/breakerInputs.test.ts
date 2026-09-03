import { describe, it, expect, beforeEach } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService } from '../PnlService.js'

/**
 * The two readings a circuit breaker acts on.
 *
 * Both are load-bearing in the same direction: get them wrong and a healthy
 * instance gets stopped. `instanceWindow` decides what "losing" means, and
 * `ledgerHealth` decides whether anyone is entitled to that opinion at all.
 */

const MIN = 60_000
const now = Date.now()
let db: SQLiteAdapter
let svc: PnlService

async function fill(o: {
  instance?: string | null; ts: number; realized?: number | null; fee?: number
  symbol?: string; account?: string; id?: string
}): Promise<void> {
  await db.run(
    `INSERT INTO pnl_fills (account, fill_id, order_id, instance_id, symbol, side, qty, price, realized_pnl, fee, ts)
     VALUES (?, ?, ?, ?, ?, 'buy', 1, 100, ?, ?, ?)`,
    [o.account ?? 'acct', o.id ?? `f${Math.random()}`, 'o1', o.instance === undefined ? 'inst' : o.instance,
      o.symbol ?? 'BTC/USDT:USDT', o.realized ?? null, o.fee ?? 0, o.ts])
}

async function claim(symbol: string, account = 'acct', instance = 'inst'): Promise<void> {
  await db.run(
    `INSERT INTO pnl_order_claims (account, order_id, instance_id, symbol, ts) VALUES (?, ?, ?, ?, ?)`,
    [account, `o${Math.random()}`, instance, symbol, now])
}

async function mark(symbol: string, ts: number, account = 'acct'): Promise<void> {
  await db.run(
    `INSERT OR REPLACE INTO pnl_watermarks (account, scope, ts) VALUES (?, ?, ?)`,
    [account, `fills:${symbol}`, ts])
}

beforeEach(async () => {
  db = new SQLiteAdapter({ filePath: ':memory:' })
  await db.initialize()
  svc = new PnlService({ db, resolveSession: async () => null, intervalMs: 10 * MIN })
})

describe('instanceWindow', () => {
  it('counts only fills inside the window', async () => {
    await fill({ ts: now - 5 * MIN, realized: -10 })
    await fill({ ts: now - 90 * MIN, realized: -1000 })   // outside
    const w = await svc.instanceWindow('inst', now - 60 * MIN)
    expect(w.realized).toBe(-10)
    expect(w.fills).toBe(1)
  })

  it('counts only this instance', async () => {
    await fill({ ts: now - 5 * MIN, realized: -10 })
    await fill({ ts: now - 5 * MIN, realized: -999, instance: 'other' })
    await fill({ ts: now - 5 * MIN, realized: -999, instance: null })   // unclaimed
    expect((await svc.instanceWindow('inst', now - 60 * MIN)).realized).toBe(-10)
  })

  it('nets realized, fees and funding — fees as a cost', async () => {
    await fill({ ts: now - 5 * MIN, realized: 100, fee: 3 })
    await db.run(
      `INSERT INTO pnl_funding (account, event_key, instance_id, symbol, amount, asset, ts)
       VALUES ('acct','e1','inst','BTC/USDT:USDT', 7, 'USDT', ?)`,
      [now - 5 * MIN])
    const w = await svc.instanceWindow('inst', now - 60 * MIN)
    expect(w.fees).toBe(-3)
    expect(w.funding).toBe(7)
    expect(w.net).toBe(104)
  })

  it('excludes funding older than the window', async () => {
    await db.run(
      `INSERT INTO pnl_funding (account, event_key, instance_id, symbol, amount, asset, ts)
       VALUES ('acct','e2','inst','BTC/USDT:USDT', -500, 'USDT', ?)`,
      [now - 90 * MIN])
    expect((await svc.instanceWindow('inst', now - 60 * MIN)).funding).toBe(0)
  })

  it('win rate counts CLOSING fills only — an open is not a loss', async () => {
    await fill({ ts: now - 1 * MIN, realized: null })   // open, realizes nothing
    await fill({ ts: now - 1 * MIN, realized: 0 })      // open, explicit zero
    await fill({ ts: now - 1 * MIN, realized: 40 })     // win
    await fill({ ts: now - 1 * MIN, realized: -10 })    // loss
    const w = await svc.instanceWindow('inst', now - 60 * MIN)
    expect(w.fills).toBe(4)
    expect(w.closingFills).toBe(2)
    expect(w.wins).toBe(1)
    expect(w.winRatePct).toBe(50)
  })

  it('win rate is null when nothing closed, not zero', async () => {
    // Zero would read as "lost every trade" and trip a win-rate rule on an
    // instance that has merely been opening positions.
    await fill({ ts: now - 1 * MIN, realized: null })
    const w = await svc.instanceWindow('inst', now - 60 * MIN)
    expect(w.closingFills).toBe(0)
    expect(w.winRatePct).toBeNull()
  })

  it('an empty window is all zeros, never NaN', async () => {
    const w = await svc.instanceWindow('inst', now - 60 * MIN)
    expect(w).toMatchObject({ realized: 0, fees: 0, funding: 0, net: 0, fills: 0, closingFills: 0, winRatePct: null })
  })
})

describe('ledgerHealth', () => {
  it('is live when every claimed symbol has a fresh watermark', async () => {
    await claim('BTC/USDT:USDT'); await mark('BTC/USDT:USDT', now - 2 * MIN)
    await claim('ETH/USDT:USDT'); await mark('ETH/USDT:USDT', now - 3 * MIN)
    const h = await svc.ledgerHealth('inst')
    expect(h.live).toBe(true)
    expect(h.pairs).toBe(2)
    expect(h.stalePairs).toBe(0)
  })

  it('is NOT live when one symbol has fallen behind', async () => {
    // The COTI shape: one symbol parked in the past while the rest collect.
    await claim('BTC/USDT:USDT'); await mark('BTC/USDT:USDT', now - 2 * MIN)
    await claim('COTI/USDT:USDT'); await mark('COTI/USDT:USDT', now - 8 * 24 * 60 * MIN)
    const h = await svc.ledgerHealth('inst')
    expect(h.live).toBe(false)
    expect(h.stalePairs).toBe(1)
    expect(h.reason).toContain('1/2')
  })

  it('is NOT live when a claimed symbol has no watermark at all', async () => {
    await claim('BTC/USDT:USDT')
    const h = await svc.ledgerHealth('inst')
    expect(h.live).toBe(false)
    expect(h.stalePairs).toBe(1)
  })

  it('is NOT live for an instance that has never claimed a fill', async () => {
    const h = await svc.ledgerHealth('inst')
    expect(h.live).toBe(false)
    expect(h.pairs).toBe(0)
    expect(h.reason).toContain('claimed no fills')
  })

  it('judges only this instance ledger, not a neighbour on the same account', async () => {
    await claim('BTC/USDT:USDT'); await mark('BTC/USDT:USDT', now - 2 * MIN)
    await claim('OLD/USDT:USDT', 'acct', 'other'); await mark('OLD/USDT:USDT', now - 999 * MIN)
    expect((await svc.ledgerHealth('inst')).live).toBe(true)
  })

  it('the staleness bound follows the collection interval', async () => {
    await claim('BTC/USDT:USDT'); await mark('BTC/USDT:USDT', now - 25 * MIN)
    // Default bound is 3 cycles = 30min at a 10min interval, so 25min is fresh.
    expect((await svc.ledgerHealth('inst')).live).toBe(true)
    expect((await svc.ledgerHealth('inst', 20 * MIN)).live).toBe(false)
  })
})
