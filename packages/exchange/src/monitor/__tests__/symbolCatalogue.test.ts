import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { BaseStrategy } from '@openwhaleorg/core'
import type { AdapterResolver, MonitorContext } from '@openwhaleorg/core'
import { TickerMonitor } from '../TickerMonitor.js'
import { KlineMonitor } from '../KlineMonitor.js'
import { MockPerpAdapter } from '../../mock/MockPerpAdapter.js'

const adapters = {
  types: () => ['binance', 'mock'],
  has: () => true,
  resolve: async () => new MockPerpAdapter(),
} as unknown as AdapterResolver

const ctx: MonitorContext = { adapters }

/** Key fields as the dashboard receives them (runtime derives these live). */
function keyFields(monitor: { readonly keySchema: z.ZodObject<z.ZodRawShape> | undefined }) {
  return BaseStrategy.deriveParamFields(monitor.keySchema!, z.object({})) ?? []
}

describe('symbol fields advertise a market catalogue', () => {
  it('carries the picker coordinates through to the derived field', () => {
    const fields = keyFields(new TickerMonitor(ctx))
    const symbol = fields.find(f => f.name === 'symbol')!
    expect(symbol.catalogue).toEqual({
      source: 'market',
      venueField: 'venue',
      kind: 'exchange/perp',
      marketType: 'swap',
    })
  })

  it('names a venue field that actually exists in the same key schema', () => {
    const fields = keyFields(new TickerMonitor(ctx))
    const symbol = fields.find(f => f.name === 'symbol')!
    expect(fields.map(f => f.name)).toContain(symbol.catalogue!.venueField)
  })

  it('leaves the field a plain string — clients ignoring the marker still work', () => {
    const symbol = keyFields(new TickerMonitor(ctx)).find(f => f.name === 'symbol')!
    expect(symbol.type).toBe('string')
    expect(symbol.options).toBeUndefined()
  })

  it('venue fields keep their fixed option list, not a catalogue', () => {
    const venue = keyFields(new TickerMonitor(ctx)).find(f => f.name === 'venue')!
    expect(venue.catalogue).toBeUndefined()
    expect(venue.options?.map(o => o.value)).toEqual(['binance'])   // 'mock' is filtered out
  })

  it('applies to every symbol-keyed monitor, including multi-segment keys', () => {
    const fields = keyFields(new KlineMonitor(ctx))
    expect(fields.map(f => f.name)).toEqual(['venue', 'symbol', 'timeframe'])
    expect(fields.find(f => f.name === 'symbol')!.catalogue?.source).toBe('market')
    // The timeframe enum stays a plain dropdown — only symbols get a catalogue
    expect(fields.find(f => f.name === 'timeframe')!.catalogue).toBeUndefined()
  })
})

describe('market catalogue source', () => {
  it('the mock venue publishes a catalogue the picker can render', async () => {
    const markets = await new MockPerpAdapter().fetchMarkets()
    expect(markets.length).toBeGreaterThan(0)
    for (const m of markets) {
      expect(m.symbol).toContain('/')
      expect(m.base).toBeTruthy()
      expect(m.quote).toBeTruthy()
      expect(m.active).toBe(true)
    }
    expect(markets.map(m => m.symbol)).toContain('BTC/USDC:USDC')
  })
})
