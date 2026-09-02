import { describe, it, expect, vi } from 'vitest'
import { createHash, createHmac } from 'crypto'
import { CrossExAdapter } from '../adapter.js'
import { parseCrossExSymbol, underlyingSymbol, roundToStep, ruleToMarket } from '../symbols.js'

/**
 * CrossEx has no testnet, so every one of these runs against a fake venue.
 * They pin the two things nothing downstream can check for us: that a request
 * is signed exactly as Gate specifies, and that a payload is mapped without
 * inventing anything the venue did not say.
 */

const KEY = 'test-key'
const SECRET = 'test-secret'

const RULE = {
  symbol: 'BINANCE_SWAP_BTC_USDT',
  exchange_type: 'BINANCE',
  business_type: 'SWAP',
  state: 'ONLINE',
  min_size: '0.001',
  min_notional: '5',
  lot_size: '0.001',
  tick_size: '0.1',
  contract_size: '1',
}

/** A venue that records what it was asked and answers from a route table. */
function fakeVenue(routes: Record<string, unknown>, status = 200) {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body?: string }> = []
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url)
    const method = init?.method ?? 'GET'
    calls.push({
      method,
      url: href,
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: String(init.body) } : {}),
    })
    const path = href.replace('https://venue.test/api/v4', '').split('?')[0]!
    const payload = routes[`${method} ${path}`] ?? routes[path]
    return new Response(payload === undefined ? '' : JSON.stringify(payload), { status })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

function adapterOn(routes: Record<string, unknown>, opts: { keys?: boolean; status?: number } = {}) {
  const venue = fakeVenue(routes, opts.status)
  const adapter = new CrossExAdapter({
    baseUrl: 'https://venue.test',
    fetchImpl: venue.impl,
    ...(opts.keys === false ? {} : { apiKey: KEY, apiSecret: SECRET }),
  })
  return { adapter, venue }
}

describe('symbols', () => {
  it('reads the exchange out of the symbol — that is where CrossEx puts it', () => {
    expect(parseCrossExSymbol('BINANCE_SWAP_BTC_USDT')).toEqual({
      exchange: 'BINANCE', business: 'SWAP', base: 'BTC', quote: 'USDT',
    })
  })

  it('names the same market on its own venue, for the data CrossEx does not serve', () => {
    expect(underlyingSymbol('BINANCE_SWAP_BTC_USDT')).toBe('BTC/USDT:USDT')
    expect(underlyingSymbol('GATE_SPOT_ETH_USDT')).toBe('ETH/USDT')
  })

  it('refuses a string that is not a CrossEx symbol instead of half-parsing it', () => {
    expect(parseCrossExSymbol('BTC/USDT:USDT')).toBeUndefined()
    expect(parseCrossExSymbol('BINANCE_SWAP_BTC')).toBeUndefined()
  })

  it('groups a market by its exchange and product line', () => {
    const market = ruleToMarket(RULE)
    expect(market).toMatchObject({ symbol: RULE.symbol, base: 'BTC', quote: 'USDT', type: 'swap', active: true })
    expect(market.tags).toEqual(['BINANCE', 'SWAP'])
  })

  it('rounds to the step without binary-float dust', () => {
    expect(roundToStep(0.30000000000000004, 0.1)).toBe(0.3)
    expect(roundToStep(1.2345, 0.001)).toBe(1.234)
    expect(roundToStep(101.06, 0.1, 'nearest')).toBe(101.1)
  })
})

describe('signing', () => {
  it('signs exactly what Gate specifies: METHOD, path, query, SHA512(body), seconds', async () => {
    const { adapter, venue } = adapterOn({ 'GET /crossex/accounts': { assets: [] } })
    await adapter.fetchBalance()

    const call = venue.calls[0]!
    const timestamp = call.headers['Timestamp']!
    const expected = createHmac('sha512', SECRET)
      .update(['GET', '/api/v4/crossex/accounts', '', createHash('sha512').update('').digest('hex'), timestamp].join('\n'))
      .digest('hex')

    expect(call.headers['KEY']).toBe(KEY)
    expect(call.headers['SIGN']).toBe(expected)
    expect(Number(timestamp)).toBeGreaterThan(1_700_000_000)
  })

  it('signs the body it actually sends', async () => {
    const { adapter, venue } = adapterOn({
      'GET /crossex/rule/symbols': [RULE],
      'POST /crossex/orders': { order_id: '1', symbol: RULE.symbol, side: 'BUY', type: 'LIMIT', state: 'NEW', qty: '1', price: '100', executed_qty: '0' },
    })
    await adapter.createOrder({ symbol: RULE.symbol, side: 'buy', type: 'limit', amount: 1, price: 100 })

    const call = venue.calls.find(c => c.method === 'POST')!
    const expected = createHmac('sha512', SECRET)
      .update(['POST', '/api/v4/crossex/orders', '', createHash('sha512').update(call.body!).digest('hex'), call.headers['Timestamp']!].join('\n'))
      .digest('hex')
    expect(call.headers['SIGN']).toBe(expected)
  })

  it('refuses a private call with no key rather than sending an unsigned one', async () => {
    const { adapter, venue } = adapterOn({ 'GET /crossex/accounts': { assets: [] } }, { keys: false })
    await expect(adapter.fetchBalance()).rejects.toThrow(/needs an API key/)
    expect(venue.calls).toHaveLength(0)
  })

  it('sends the broker channel on orders and on nothing else', async () => {
    const venue = fakeVenue({
      'GET /crossex/rule/symbols': [RULE],
      'GET /crossex/accounts': { assets: [] },
      'POST /crossex/orders': { order_id: '1', symbol: RULE.symbol, side: 'BUY', type: 'MARKET', state: 'FILLED', qty: '1', price: '0', executed_qty: '1' },
    })
    const adapter = new CrossExAdapter({ baseUrl: 'https://venue.test', fetchImpl: venue.impl, apiKey: KEY, apiSecret: SECRET, channelId: 'openwhale' })
    await adapter.fetchBalance()
    await adapter.createOrder({ symbol: RULE.symbol, side: 'buy', type: 'market', amount: 1 })

    expect(venue.calls.find(c => c.url.includes('accounts'))!.headers['X-Gate-Channel-Id']).toBeUndefined()
    expect(venue.calls.find(c => c.method === 'POST')!.headers['X-Gate-Channel-Id']).toBe('openwhale')
  })
})

describe('errors', () => {
  it('treats a rejected request as terminal and keeps the venue label', async () => {
    const { adapter } = adapterOn({ 'GET /crossex/accounts': { label: 'BALANCE_NOT_ENOUGH' } }, { status: 400 })
    await expect(adapter.fetchBalance()).rejects.toMatchObject({ retryable: false, message: /BALANCE_NOT_ENOUGH/ })
  })

  it('treats a rate limit as retryable', async () => {
    const { adapter } = adapterOn({ 'GET /crossex/accounts': { label: 'TOO_MANY_REQUESTS' } }, { status: 429 })
    await expect(adapter.fetchBalance()).rejects.toMatchObject({ retryable: true })
  })
})

describe('market data', () => {
  it('reports no bid/ask rather than inventing a zero-width spread', async () => {
    const { adapter } = adapterOn({
      'GET /crossex/market/tickers': [{
        symbol: RULE.symbol, last_price: '101.5', open_24h: '100', low_24h: '99', high_24h: '102',
        volume_24h_base: '10', volume_24h_quote: '1000', mark_price: '101.4', index_price: '101.3',
        open_interest: '55', timestamp: '1788000000000',
      }],
    })
    const ticker = await adapter.fetchTicker(RULE.symbol)
    expect(ticker).toMatchObject({ last: 101.5, bid: 0, ask: 0, high: 102, volume: 10 })
  })

  it('normalises a funding interval whether the venue states seconds or hours', async () => {
    const { adapter } = adapterOn({
      'GET /crossex/market/funding_info': [
        { symbol: 'BINANCE_SWAP_BTC_USDT', funding_rate: '0.0001', funding_interval: '28800', funding_time: '1788000000000' },
        { symbol: 'OKX_SWAP_ETH_USDT', funding_rate: '-0.0002', funding_interval: '4', funding_time: '1788000000000' },
      ],
    })
    const rates = await adapter.fetchFundingRates()
    expect(rates[0]).toMatchObject({ fundingRate: 0.0001, intervalHours: 8 })
    expect(rates[1]).toMatchObject({ fundingRate: -0.0002, intervalHours: 4 })
  })

  it('points at the underlying venue for the depth CrossEx does not serve', async () => {
    const { adapter } = adapterOn({})
    await expect(adapter.fetchOrderBook('BINANCE_SWAP_BTC_USDT')).rejects.toThrow(/binance:BTC\/USDT:USDT/)
    await expect(adapter.fetchOHLCV('OKX_SWAP_ETH_USDT', '1h')).rejects.toThrow(/okx:ETH\/USDT:USDT/)
  })
})

describe('precision', () => {
  it('rounds an amount down to the lot and a price to the tick', async () => {
    const { adapter } = adapterOn({ 'GET /crossex/rule/symbols': [RULE] })
    expect(await adapter.amountToPrecision(RULE.symbol, 0.0019)).toBe(0.001)
    expect(await adapter.priceToPrecision(RULE.symbol, 101.06)).toBe(101.1)
  })

  it('names an unlisted symbol instead of rounding against nothing', async () => {
    const { adapter } = adapterOn({ 'GET /crossex/rule/symbols': [RULE] })
    await expect(adapter.amountToPrecision('BINANCE_SWAP_DOGE_USDT', 1)).rejects.toThrow(/does not list/)
    await expect(adapter.amountToPrecision('BTC/USDT:USDT', 1)).rejects.toThrow(/exchange_business_base_quote/)
  })
})

describe('orders and positions', () => {
  it('sends the venue vocabulary: sides upper-cased, post-only as POC, reduce-only as a string', async () => {
    const { adapter, venue } = adapterOn({
      'GET /crossex/rule/symbols': [RULE],
      'POST /crossex/orders': { order_id: '9', symbol: RULE.symbol, side: 'SELL', type: 'LIMIT', state: 'NEW', qty: '2', price: '105', executed_qty: '0', time_in_force: 'POC', reduce_only: 'true' },
    })
    const order = await adapter.createOrder({
      symbol: RULE.symbol, side: 'sell', type: 'limit', amount: 2, price: 105,
      timeInForce: 'PO', reduceOnly: true, positionSide: 'short', clientOrderId: 'ow-1',
    })

    expect(JSON.parse(venue.calls.find(c => c.method === 'POST')!.body!)).toMatchObject({
      symbol: RULE.symbol, side: 'SELL', type: 'LIMIT', qty: '2', price: '105',
      time_in_force: 'POC', reduce_only: 'true', position_side: 'SHORT', text: 'ow-1',
    })
    expect(order).toMatchObject({ id: '9', side: 'sell', timeInForce: 'PO', reduceOnly: true, status: 'open', remaining: 2 })
  })

  it('refuses a limit order with no price, and a trigger order the route cannot place', async () => {
    const { adapter } = adapterOn({})
    await expect(adapter.createOrder({ symbol: RULE.symbol, side: 'buy', type: 'limit', amount: 1 })).rejects.toThrow(/need a price/)
    await expect(adapter.createOrder({ symbol: RULE.symbol, side: 'buy', type: 'market', amount: 1, triggerPrice: 9 })).rejects.toThrow(/trigger orders/)
  })

  it('reads a short position as short, with its own margin numbers', async () => {
    const { adapter } = adapterOn({
      'GET /crossex/positions': [{
        symbol: RULE.symbol, position_side: 'SHORT', position_qty: '0.5', position_value: '50000',
        entry_price: '100000', mark_price: '99000', upnl: '500', leverage: '5',
        initial_margin: '10000', maintenance_margin: '250', liq_price: '120000',
      }],
    })
    const [position] = await adapter.fetchPositions()
    expect(position).toMatchObject({
      symbol: RULE.symbol, side: 'short', contracts: 0.5, notional: 50000,
      unrealizedPnl: 500, leverage: 5, marginMode: 'cross', liquidationPrice: 120000,
    })
  })

  it('reports a symbol with no position as flat instead of failing', async () => {
    const { adapter } = adapterOn({ 'GET /crossex/positions': [] })
    expect(await adapter.fetchPosition(RULE.symbol)).toMatchObject({ contracts: 0, notional: 0 })
  })

  it('cancels the open orders in ONE batch, and complains when every one is refused', async () => {
    const open = [{ order_id: 'a', symbol: RULE.symbol, side: 'BUY', type: 'LIMIT', state: 'NEW', qty: '1', price: '1', executed_qty: '0' }]
    const { adapter, venue } = adapterOn({
      'GET /crossex/open_orders': open,
      'POST /crossex/batch_cancel_orders': [{ order_id: 'a', text: '', accepted: 'false', label: 'ORDER_NOT_FOUND', message: 'gone' }],
    })
    await expect(adapter.cancelAllOrders()).rejects.toThrow(/ORDER_NOT_FOUND/)
    expect(venue.calls.filter(c => c.method === 'POST')).toHaveLength(1)
  })

  it('says nothing to cancel without calling the venue', async () => {
    const { adapter, venue } = adapterOn({ 'GET /crossex/open_orders': [] })
    await adapter.cancelAllOrders()
    expect(venue.calls.filter(c => c.method === 'POST')).toHaveLength(0)
  })

  it('refuses isolated margin — the shared pool is the product', async () => {
    const { adapter } = adapterOn({})
    await expect(adapter.setMarginMode(RULE.symbol, 'isolated')).rejects.toThrow(/one margin pool/)
    await expect(adapter.setMarginMode(RULE.symbol, 'cross')).resolves.toBeUndefined()
  })

  it('answers "did my order land" with undefined when it did not', async () => {
    const { adapter } = adapterOn({}, { status: 404 })
    expect(await adapter.fetchOrderByClientId('ow-never-sent', RULE.symbol)).toBeUndefined()
  })
})

describe('account equity', () => {
  it('reports the venue pooled figures rather than summing wallets', async () => {
    const { adapter } = adapterOn({
      'GET /crossex/accounts': {
        total_equity: '12345.6', available_balance: '4321', position_mode: 'DUAL',
        assets: [{ coin: 'USDT', total: '-100', available: '0' }, { coin: 'BTC', total: '0.5', available: '0.5' }],
      },
    })
    expect(await adapter.fetchPortfolioEquity()).toEqual({ equityUsd: 12345.6, availableUsd: 4321 })
    // A negative wallet is a loan against the pool, not an error to hide.
    expect(await adapter.fetchBalance()).toEqual([
      { currency: 'USDT', free: 0, used: 0, total: -100 },
      { currency: 'BTC', free: 0.5, used: 0, total: 0.5 },
    ])
    expect(await adapter.fetchPositionMode()).toEqual({ hedged: true })
  })
})
