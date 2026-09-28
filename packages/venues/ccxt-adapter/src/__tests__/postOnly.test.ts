import { describe, it, expect } from 'vitest'
import { CcxtAdapter } from '../CcxtAdapter.js'

/**
 * Post-only, spelled the way each venue spells it.
 *
 * Binance wants GTX, Hyperliquid wants `Alo`, and ccxt already owns that
 * translation behind its `postOnly` flag. The unified 'PO' string only works
 * where a venue's ccxt implementation lists it — Binance does, Hyperliquid
 * does not. Hyperliquid lowercases and re-capitalizes whatever it is handed,
 * so 'PO' arrived as `{"limit":{"tif":"Po"}}`, which is not a variant of its
 * tif enum: the request failed to deserialize, and the 422 said only "Failed
 * to deserialize the JSON body into the target type" with no mention of the
 * field (2026-09-28, a BBO leg on HYPE).
 */

/** An adapter whose ccxt layer records the params a createOrder was given. */
class Probe extends CcxtAdapter {
  sent: Record<string, unknown> | undefined

  constructor(exchangeId: string) {
    super({ exchangeId })
    const e = this.exchange as unknown as Record<string, unknown>
    e['loadMarkets'] = async () => ({})
    e['market'] = () => ({ symbol: 'X/USDC:USDC', precision: { amount: 8, price: 8 }, limits: {} })
    e['amountToPrecision'] = (_s: string, a: number) => String(a)
    e['priceToPrecision'] = (_s: string, p: number) => String(p)
    e['createOrder'] = async (_sym: string, _t: string, _side: string, _amt: number, _px: number, params: Record<string, unknown>) => {
      this.sent = params
      return { id: '1', symbol: 'X/USDC:USDC', side: 'buy', amount: 1, filled: 0, remaining: 1, status: 'open', timestamp: Date.now() }
    }
  }
}

const order = (tif?: string) => ({
  symbol: 'X/USDC:USDC', side: 'buy' as const, type: 'limit' as const, amount: 1, price: 100,
  ...(tif ? { timeInForce: tif as 'GTC' | 'IOC' | 'FOK' | 'PO' } : {}),
})

describe('post-only reaches the venue as the venue wants it', () => {
  it('PO becomes ccxt\'s postOnly, and the raw string is not sent', async () => {
    for (const venue of ['hyperliquid', 'binanceusdm']) {
      const p = new Probe(venue)
      await p.createOrder(order('PO'))
      expect(p.sent!['postOnly'], venue).toBe(true)
      // The string must NOT ride along: hyperliquid would capitalize it into
      // a tif variant that does not exist and refuse the whole body.
      expect(p.sent!['timeInForce'], venue).toBeUndefined()
    }
  })

  it('every other timeInForce passes through untouched', async () => {
    for (const tif of ['GTC', 'IOC', 'FOK']) {
      const p = new Probe('hyperliquid')
      await p.createOrder(order(tif))
      expect(p.sent!['timeInForce'], tif).toBe(tif)
      expect(p.sent!['postOnly'], tif).toBeUndefined()
    }
  })

  it('an order that asks for nothing carries neither', async () => {
    const p = new Probe('hyperliquid')
    await p.createOrder(order())
    expect(p.sent!['timeInForce']).toBeUndefined()
    expect(p.sent!['postOnly']).toBeUndefined()
  })
})
