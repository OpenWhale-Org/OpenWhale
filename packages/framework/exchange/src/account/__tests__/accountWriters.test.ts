import { describe, it, expect } from 'vitest'
import { PerpAccount } from '../PerpAccount.js'
import { PerpAccountWriter } from '../PerpAccountWriter.js'
import { SpotAccount } from '../SpotAccount.js'
import { SpotAccountWriter } from '../SpotAccountWriter.js'
import type { PerpExchangeAdapter } from '../../types/perp.js'
import type { SpotExchangeAdapter } from '../../types/spot.js'

/**
 * The write views of the two built-in kinds. The reads are covered elsewhere;
 * what matters here is that a write reaches the venue in the shape the venue
 * expects, and that the reader beside it still cannot write.
 */

interface Sent { symbol: string; side: string; type: string; amount: number; reduceOnly?: boolean; price?: number; positionSide?: string }

function perpSession(over: Partial<PerpExchangeAdapter> = {}) {
  const sent: Sent[] = []
  const cancelled: Array<string | undefined> = []
  const session = {
    supportsPositionSide: false,
    // 0.001 lots — big enough that a sloppy percentage rounds visibly.
    amountToPrecision: async (_s: string, a: number) => Math.floor(a * 1000) / 1000,
    priceToPrecision: async (_s: string, p: number) => Math.round(p * 100) / 100,
    createOrder: async (p: Sent) => { sent.push(p); return { id: 'ord-1', ...p } },
    cancelOrder: async (id: string) => { cancelled.push(id) },
    cancelAllOrders: async (symbol?: string) => { cancelled.push(symbol) },
    fetchPositions: async () => [],
    setLeverage: async () => undefined,
    setMarginMode: async () => undefined,
    ...over,
  } as unknown as PerpExchangeAdapter
  return { session, sent, cancelled, calls: [] as string[] }
}

describe('PerpAccountWriter', () => {
  it('rounds the amount to the venue lot before sending', async () => {
    const rig = perpSession()
    const w = new PerpAccountWriter('acct', rig.session)
    await w.placeOrder({ symbol: 'BTC/USDT:USDT', side: 'buy', type: 'market', amount: 0.123456 })
    expect(rig.sent[0]).toMatchObject({ symbol: 'BTC/USDT:USDT', side: 'buy', type: 'market', amount: 0.123 })
  })

  it('refuses an amount that rounds to nothing rather than sending a zero order', async () => {
    const rig = perpSession()
    const w = new PerpAccountWriter('acct', rig.session)
    await expect(w.placeOrder({ symbol: 'BTC/USDT:USDT', side: 'buy', type: 'market', amount: 0.0001 }))
      .rejects.toThrow(/rounds to zero/)
    expect(rig.sent).toEqual([])
  })

  it('refuses a limit order with no price — the venue error for this is unreadable', async () => {
    const rig = perpSession()
    const w = new PerpAccountWriter('acct', rig.session)
    await expect(w.placeOrder({ symbol: 'BTC/USDT:USDT', side: 'buy', type: 'limit', amount: 1 }))
      .rejects.toThrow(/needs a price/)
  })

  it('closePosition reads the live size and always sends reduce-only', async () => {
    const rig = perpSession({
      fetchPositions: async () => [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 2, notional: 100_000 }],
    } as Partial<PerpExchangeAdapter>)
    const w = new PerpAccountWriter('acct', rig.session)
    await w.closePosition({ symbol: 'BTC/USDT:USDT' })
    // A long closes by selling, and reduceOnly means a stale read can only
    // under-close — never flip the position to the other side.
    expect(rig.sent[0]).toMatchObject({ side: 'sell', type: 'market', amount: 2, reduceOnly: true })
  })

  it('closePosition takes a percentage of what is actually held', async () => {
    const rig = perpSession({
      fetchPositions: async () => [{ symbol: 'ETH/USDT:USDT', side: 'short', contracts: 10, notional: 30_000 }],
    } as Partial<PerpExchangeAdapter>)
    const w = new PerpAccountWriter('acct', rig.session)
    await w.closePosition({ symbol: 'ETH/USDT:USDT', percent: 25 })
    expect(rig.sent[0]).toMatchObject({ side: 'buy', amount: 2.5, reduceOnly: true })
  })

  it('closePosition refuses when the venue shows nothing to close', async () => {
    const rig = perpSession()
    const w = new PerpAccountWriter('acct', rig.session)
    await expect(w.closePosition({ symbol: 'BTC/USDT:USDT' })).rejects.toThrow(/No open position/)
    expect(rig.sent).toEqual([])
  })

  it('sends positionSide only where the venue runs hedge mode', async () => {
    const oneWay = perpSession({
      fetchPositions: async () => [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 1, notional: 50_000 }],
    } as Partial<PerpExchangeAdapter>)
    await new PerpAccountWriter('a', oneWay.session).closePosition({ symbol: 'BTC/USDT:USDT' })
    // A netting venue REJECTS positionSide, so sending it would fail the close.
    expect(oneWay.sent[0]!.positionSide).toBeUndefined()

    const hedged = perpSession({
      supportsPositionSide: true,
      fetchPositions: async () => [{ symbol: 'BTC/USDT:USDT', side: 'long', contracts: 1, notional: 50_000 }],
    } as Partial<PerpExchangeAdapter>)
    await new PerpAccountWriter('a', hedged.session).closePosition({ symbol: 'BTC/USDT:USDT' })
    expect(hedged.sent[0]!.positionSide).toBe('long')
  })

  it('setLeverage switches the margin mode first, carrying the leverage with it', async () => {
    const order: string[] = []
    const rig = perpSession({
      setMarginMode: async (_s: string, m: string, p?: Record<string, unknown>) => { order.push(`mode:${m}:${p?.['leverage']}`) },
      setLeverage: async (_s: string, l: number) => { order.push(`lev:${l}`) },
    } as Partial<PerpExchangeAdapter>)
    await new PerpAccountWriter('a', rig.session).setLeverage({ symbol: 'BTC/USDT:USDT', leverage: 5, marginMode: 'isolated' })
    // Hyperliquid wants the leverage alongside the mode, and several venues
    // refuse a mode switch that trails the leverage change.
    expect(order).toEqual(['mode:isolated:5', 'lev:5'])
  })

  it('every declared action has a method behind it', () => {
    for (const action of PerpAccountWriter.actions) {
      expect(typeof (PerpAccountWriter.prototype as unknown as Record<string, unknown>)[action.id]).toBe('function')
    }
  })

  it('the READER exposes none of the writer’s methods', () => {
    const reader = new PerpAccount('acct', perpSession().session) as unknown as Record<string, unknown>
    for (const action of PerpAccountWriter.actions) expect(typeof reader[action.id]).not.toBe('function')
  })
})

function spotSession() {
  const sent: Sent[] = []
  const cancelled: Array<string | undefined> = []
  const session = {
    amountToPrecision: async (_s: string, a: number) => Math.floor(a * 1000) / 1000,
    priceToPrecision: async (_s: string, p: number) => Math.round(p * 100) / 100,
    createOrder: async (p: Sent) => { sent.push(p); return { id: 'ord-1', ...p } },
    cancelOrder: async (id: string) => { cancelled.push(id) },
    cancelAllOrders: async (symbol?: string) => { cancelled.push(symbol) },
    fetchOpenOrders: async () => [],
  } as unknown as SpotExchangeAdapter
  return { session, sent, cancelled }
}

describe('SpotAccountWriter', () => {
  it('rounds to the lot and passes the rounded price through', async () => {
    const rig = spotSession()
    await new SpotAccountWriter('a', rig.session).placeOrder({
      symbol: 'ETH/USDT', side: 'sell', type: 'limit', amount: 1.98765, price: 3210.567,
    })
    expect(rig.sent[0]).toMatchObject({ amount: 1.987, price: 3210.57 })
  })

  it('cancelAllOrders without a symbol means the whole account', async () => {
    const rig = spotSession()
    await new SpotAccountWriter('a', rig.session).cancelAllOrders({})
    expect(rig.cancelled).toEqual([undefined])
  })

  it('every declared action has a method behind it', () => {
    for (const action of SpotAccountWriter.actions) {
      expect(typeof (SpotAccountWriter.prototype as unknown as Record<string, unknown>)[action.id]).toBe('function')
    }
  })

  it('the READER exposes none of the writer’s methods', () => {
    const reader = new SpotAccount('acct', spotSession().session) as unknown as Record<string, unknown>
    for (const action of SpotAccountWriter.actions) expect(typeof reader[action.id]).not.toBe('function')
  })
})
