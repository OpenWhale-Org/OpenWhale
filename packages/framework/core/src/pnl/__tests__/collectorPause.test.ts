import { describe, it, expect, vi } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PnlService } from '../PnlService.js'

/**
 * The collector's switch. Paused, it sends the venue nothing on its own —
 * neither the periodic sweep nor the pass a fresh claim triggers — while
 * claims keep landing in the ledger. Resumed, it sweeps once at once, so
 * nothing that filled while it was off is lost.
 */

async function setup() {
  const db = new SQLiteAdapter({ filePath: ':memory:' })
  await db.initialize()
  await db.run(`INSERT INTO pnl_order_claims (account, order_id, instance_id, symbol, ts) VALUES ('acct', 'o0', 'inst', 'BTC/USDC:USDC', ?)`, [Date.now()])
  const asked: string[] = []
  const svc = new PnlService({
    db,
    intervalMs: 60_000,
    resolveSession: async () => ({ fetchFills: async (symbol: string) => { asked.push(symbol); return [] } }) as never,
  })
  return { db, svc, asked }
}

describe('PnL collector pause', () => {
  it('paused: no sweep, no claim-triggered pass — but claims are still recorded', async () => {
    vi.useFakeTimers()
    const { db, svc, asked } = await setup()
    svc.start()
    svc.setPaused(true)
    await svc.recordClaim({ account: 'acct', symbol: 'ETH/USDC:USDC', orderId: 'o1', instanceId: 'inst', ts: Date.now() })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(asked).toEqual([])
    expect(svc.status()).toMatchObject({ paused: true })
    const claims = await db.all<{ order_id: string }>('SELECT order_id FROM pnl_order_claims ORDER BY order_id')
    expect(claims.map(c => c.order_id)).toEqual(['o0', 'o1'])
    svc.stop()
    vi.useRealTimers()
  })

  it('resumed: sweeps at once and re-arms the timer', async () => {
    vi.useFakeTimers()
    const { svc, asked } = await setup()
    svc.start()
    svc.setPaused(true)
    svc.setPaused(false)
    await vi.waitFor(() => expect(asked).toEqual(['BTC/USDC:USDC']))
    expect(svc.status()).toMatchObject({ paused: false })
    expect(svc.status().lastCollectAt).toBeTypeOf('number')
    await vi.advanceTimersByTimeAsync(61_000)
    await vi.waitFor(() => expect(asked.length).toBe(2))
    svc.stop()
    vi.useRealTimers()
  })

  it('an explicit collect still runs while paused', async () => {
    const { svc, asked } = await setup()
    svc.setPaused(true)
    await svc.collect()
    expect(asked).toEqual(['BTC/USDC:USDC'])
  })
})
