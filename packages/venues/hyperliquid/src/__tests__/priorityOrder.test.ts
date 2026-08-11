import { describe, it, expect, beforeEach } from 'vitest'
import ccxt from 'ccxt'
import { HyperliquidAdapter, BUILDER_ADDRESS, BUILDER_TENTHS_BP } from '../adapter.js'

/**
 * What the priority path actually puts on the wire.
 *
 * These assertions run ccxt's REAL createOrderRequest — only the network is
 * stubbed. That matters: the bug this file exists for was a disagreement
 * between our hand-assembled action and ccxt's own order construction, and a
 * test that re-implemented the price math would have agreed with the bug.
 */

const SYMBOL = 'BTC/USDC:USDC'

function fakeExchange() {
  const ex = new ccxt.hyperliquid({ walletAddress: '0x' + '1'.repeat(40), privateKey: '0x' + '2'.repeat(64) })
  ex.setMarkets([{
    id: 'BTC', symbol: SYMBOL, base: 'BTC', quote: 'USDC', settle: 'USDC',
    baseId: '0', quoteId: 'USDC', settleId: 'USDC',
    type: 'swap', spot: false, swap: true, future: false, option: false,
    contract: true, linear: true, inverse: false, active: true,
    precision: { amount: 5, price: 5 },
    limits: { amount: { min: 0 }, price: {}, cost: {}, leverage: {} },
    info: { name: 'BTC', szDecimals: '5' },
  }] as never)

  const sent: Array<Record<string, unknown>> = []
  Object.assign(ex, {
    loadMarkets: async () => ex.markets,
    initializeClient: async () => true,
    signL1Action: () => 'sig',
    privatePostExchange: async (req: Record<string, unknown>) => {
      sent.push(req)
      return { status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { oid: 7, totalSz: '1', avgPx: '60000' } }] } } }
    },
  })
  return { ex, sent }
}

/** The order object of the single order in the last action sent. */
function lastOrder(sent: Array<Record<string, unknown>>) {
  const action = sent.at(-1)?.['action'] as { orders: Array<Record<string, unknown>>, grouping: unknown }
  return { order: action.orders[0]!, grouping: action.grouping }
}

describe('priority order construction', () => {
  let adapter: HyperliquidAdapter
  let sent: Array<Record<string, unknown>>

  beforeEach(() => {
    const fake = fakeExchange()
    sent = fake.sent
    adapter = new HyperliquidAdapter({ walletAddress: '0x' + '1'.repeat(40), privateKey: '0x' + '2'.repeat(64) })
    ;(adapter as unknown as { exchange: unknown }).exchange = fake.ex
  })

  // The whole point of paying for sequencing is to GET FILLED at the contested
  // moment. An IOC limit resting at the reference price crosses nothing: a sell
  // at mid needs a bid at or above mid, and at settlement there isn't one.
  it('a market order keeps its crossing margin', async () => {
    await adapter.createOrder({
      symbol: SYMBOL, side: 'sell', type: 'market', amount: 1, price: 60_000,
      params: { priorityBps: 1 },
    })
    const { order } = lastOrder(sent)
    // 60 000 × (1 − 0.05) — ccxt's default slippage, same as the plain path
    expect(Number(order['p'])).toBeCloseTo(57_000, 0)
    expect(order['r']).toBe(false)
    expect((order['t'] as { limit: { tif: string } }).limit.tif).toBe('Ioc')
  })

  it('a buy crosses upward', async () => {
    await adapter.createOrder({
      symbol: SYMBOL, side: 'buy', type: 'market', amount: 1, price: 60_000,
      params: { priorityBps: 1 },
    })
    expect(Number(lastOrder(sent).order['p'])).toBeCloseTo(63_000, 0)
  })

  it('an explicit slippage overrides the default', async () => {
    await adapter.createOrder({
      symbol: SYMBOL, side: 'sell', type: 'market', amount: 1, price: 60_000,
      params: { priorityBps: 1, slippage: 0.01 },
    })
    expect(Number(lastOrder(sent).order['p'])).toBeCloseTo(59_400, 0)
  })

  // On a netting venue an exit is reduce-only, and dropping the flag turns an
  // oversized close into an opening trade in the opposite direction.
  it('reduceOnly survives the hand-assembled action', async () => {
    await adapter.createOrder({
      symbol: SYMBOL, side: 'sell', type: 'market', amount: 1, price: 60_000,
      reduceOnly: true, params: { priorityBps: 1 },
    })
    expect(lastOrder(sent).order['r']).toBe(true)
  })

  it('a limit order is priced exactly where the caller asked', async () => {
    await adapter.createOrder({
      symbol: SYMBOL, side: 'sell', type: 'limit', amount: 1, price: 60_000,
      timeInForce: 'IOC', params: { priorityBps: 1 },
    })
    expect(Number(lastOrder(sent).order['p'])).toBe(60_000)
  })

  it('carries the rate as the venue reads it', async () => {
    await adapter.createOrder({
      symbol: SYMBOL, side: 'sell', type: 'market', amount: 1, price: 60_000,
      params: { priorityBps: 2.5 },
    })
    expect(lastOrder(sent).grouping).toEqual({ p: 25_000 })
  })

  it('the client order id rides along', async () => {
    await adapter.createOrder({
      symbol: SYMBOL, side: 'sell', type: 'market', amount: 1, price: 60_000,
      clientOrderId: '0x' + 'a'.repeat(32), params: { priorityBps: 1 },
    })
    expect(lastOrder(sent).order['c']).toBe('0x' + 'a'.repeat(32))
  })
})

describe('builder code', () => {
  function adapterWith(credentials: Record<string, unknown>) {
    const fake = fakeExchange()
    const a = new HyperliquidAdapter({
      walletAddress: '0x' + '1'.repeat(40), privateKey: '0x' + '2'.repeat(64), ...credentials,
    } as never)
    ;(a as unknown as { exchange: unknown }).exchange = fake.ex
    return { adapter: a, ...fake }
  }

  // The address and rate are the product's, not ccxt's. ccxt ships its own
  // address with builderFee on by default, so leaving this unset does not mean
  // "no fee" — it means someone else's fee.
  it('defaults to our address at the rate ccxt was already charging', () => {
    const a = new HyperliquidAdapter({ walletAddress: '0x' + '1'.repeat(40) })
    const o = (a as unknown as { exchange: { options: Record<string, unknown> } }).exchange.options
    expect(o['builderFee']).toBe(true)
    expect(o['builder']).toBe(BUILDER_ADDRESS)
    expect(o['feeInt']).toBe(BUILDER_TENTHS_BP)
  })

  it('can be redirected', () => {
    const other = '0x' + '9'.repeat(40)
    const a = new HyperliquidAdapter({ walletAddress: '0x' + '1'.repeat(40), builder: other })
    const o = (a as unknown as { exchange: { options: Record<string, unknown> } }).exchange.options
    expect(o['builder']).toBe(other)
  })

  // The honest opt-out: no fee, and no approval signed on the trader's behalf.
  it('can be switched off entirely', () => {
    const a = new HyperliquidAdapter({ walletAddress: '0x' + '1'.repeat(40), builder: false })
    const o = (a as unknown as { exchange: { options: Record<string, unknown> } }).exchange.options
    expect(o['builderFee']).toBe(false)
  })

  // The priority path hand-builds the action, so it does not inherit ccxt's
  // builder handling — without this it would silently charge nothing.
  it('rides along on a priority order once approved', async () => {
    const { adapter, ex, sent } = adapterWith({})
    ;(ex.options as Record<string, unknown>)['approvedBuilderFee'] = true
    ;(ex.options as Record<string, unknown>)['builder'] = BUILDER_ADDRESS
    ;(ex.options as Record<string, unknown>)['feeInt'] = BUILDER_TENTHS_BP

    await adapter.createOrder({
      symbol: SYMBOL, side: 'sell', type: 'market', amount: 1, price: 60_000,
      params: { priorityBps: 1 },
    })
    const action = sent.at(-1)!['action'] as Record<string, unknown>
    expect(action['builder']).toEqual({ b: BUILDER_ADDRESS.toLowerCase(), f: BUILDER_TENTHS_BP })
    // Signing is msgpack over the action, so key order is part of the payload.
    expect(Object.keys(action)).toEqual(['type', 'orders', 'grouping', 'builder'])
  })

  it('is absent on a priority order when no approval exists', async () => {
    const { adapter, sent } = adapterWith({})
    await adapter.createOrder({
      symbol: SYMBOL, side: 'sell', type: 'market', amount: 1, price: 60_000,
      params: { priorityBps: 1 },
    })
    expect((sent.at(-1)!['action'] as Record<string, unknown>)['builder']).toBeUndefined()
  })
})

describe('builder fee accounting', () => {
  // ccxt's parseTrade adds `builderFee` on top of `fee`, but Hyperliquid's
  // `fee` already includes it. Numbers below are a real fill from 2026-08-11.
  function adapterWithFills(trades: unknown[]) {
    const fake = fakeExchange()
    Object.assign(fake.ex, { fetchMyTrades: async () => trades })
    const a = new HyperliquidAdapter({ walletAddress: '0x' + '1'.repeat(40) })
    ;(a as unknown as { exchange: unknown }).exchange = fake.ex
    return a
  }

  it('subtracts the builder portion ccxt added twice', async () => {
    // Venue reported fee 0.095074 (base 0.077204 + builder 0.017871);
    // ccxt hands us 0.112945 = 0.095074 + 0.017871.
    const a = adapterWithFills([{
      id: '1', order: '9', symbol: SYMBOL, side: 'buy', amount: 276, price: 0.64751,
      timestamp: 1, fee: { cost: 0.112945, currency: 'USDC' },
      info: { fee: '0.095074', builderFee: '0.017871', closedPnl: '0' },
    }])
    const fills = await a.fetchFills(SYMBOL)
    expect(fills[0]!.fee).toBeCloseTo(0.095074, 6)
  })

  it('leaves a fill without a builder fee alone', async () => {
    const a = adapterWithFills([{
      id: '1', order: '9', symbol: SYMBOL, side: 'buy', amount: 276, price: 0.64751,
      timestamp: 1, fee: { cost: 0.077204, currency: 'USDC' },
      info: { fee: '0.077204', closedPnl: '0' },
    }])
    expect((await a.fetchFills(SYMBOL))[0]!.fee).toBeCloseTo(0.077204, 6)
  })
})
