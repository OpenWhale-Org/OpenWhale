import { describe, it, expect } from 'vitest'
import ccxt from 'ccxt'
import type { OpenWhalePlugin, PluginContext } from '@openwhaleorg/core'
import type { ZodObject, ZodRawShape } from 'zod'
import { canFetchPositionMode, positionSideForVenue } from '@openwhaleorg/ccxt-adapter'
import { VENUE_SPECS, venuePlugins, allVenuePlugins, buildVenueAdapter, venueKinds } from '../index.js'

/** definePlugin returns a factory — lower it exactly the way the runtime does. */
function lower(name: string): OpenWhalePlugin {
  return venuePlugins[name]!({ credentials: {}, config: {} } as unknown as PluginContext)
}

/** The venue's credential form schema (every roster venue registers exactly one). */
function credentialSchema(name: string): ZodObject<ZodRawShape> {
  const schema = lower(name).credentialTypes?.[0]?.schema
  if (!schema) throw new Error(`venue "${name}" registered no credential schema`)
  return schema
}

/**
 * These tests are the roster's contract with ccxt: every declared exchange id
 * must exist, serve the market types we claim, and want exactly the
 * credentials our form asks for. A ccxt upgrade that renames an id or adds a
 * required field fails here instead of at a user's first order.
 */

describe('venue roster', () => {
  it('formats hedge-mode positionSide using each venue API casing', () => {
    expect(positionSideForVenue('okx', 'long')).toBe('long')
    expect(positionSideForVenue('okx', 'short')).toBe('short')
    expect(positionSideForVenue('binanceusdm', 'long')).toBe('LONG')
    expect(positionSideForVenue('binanceusdm', 'short')).toBe('SHORT')
  })

  it('uses OKX position-mode support despite ccxt 4.5.x missing the capability flag', () => {
    expect(canFetchPositionMode('okx', undefined)).toBe(true)
    expect(canFetchPositionMode('okx', false)).toBe(true)
    expect(canFetchPositionMode('binanceusdm', true)).toBe(true)
    expect(canFetchPositionMode('unsupported', undefined)).toBe(false)
  })

  it('declares a plugin per venue, all named and namespaced by the venue', () => {
    expect(allVenuePlugins.length).toBe(VENUE_SPECS.length)
    for (const spec of VENUE_SPECS) {
      const plugin = lower(spec.name)
      expect(plugin.name).toBe(spec.name)
      // The credential type IS the venue name — accounts and adapters key off it
      expect(plugin.credentialTypes?.map(c => c.type)).toEqual([spec.name])
      expect(plugin.adapters?.map(a => a.type)).toEqual(venueKinds(spec).map(() => spec.name))
      expect(plugin.adapters?.map(a => a.kind)).toEqual(venueKinds(spec))
    }
  })

  it('venue names and credential types are unique across the roster', () => {
    const names = VENUE_SPECS.map(s => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it.each(VENUE_SPECS.map(s => [s.name, s] as const))('%s: ccxt id exists and serves the declared kinds', (_name, spec) => {
    for (const [kind, exchangeId] of Object.entries(spec.markets)) {
      expect(ccxt.exchanges).toContain(exchangeId)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const probe = new (ccxt as any)[exchangeId]() as { has: Record<string, unknown> }
      const needed = kind === 'exchange/perp' ? 'swap' : 'spot'
      expect(probe.has[needed], `${exchangeId} must support ${needed} for ${kind}`).toBe(true)
    }
  })

  it.each(VENUE_SPECS.map(s => [s.name, s] as const))('%s: the credential form covers what ccxt requires', (_name, spec) => {
    const exchangeId = Object.values(spec.markets)[0]!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe = new (ccxt as any)[exchangeId]() as { requiredCredentials: Record<string, boolean> }
    const required = Object.entries(probe.requiredCredentials).filter(([, v]) => v).map(([k]) => k)
    const fields = Object.keys(credentialSchema(spec.name).shape)
    for (const key of required) {
      expect(fields, `${spec.name} form is missing ccxt-required "${key}"`).toContain(key)
    }
  })

  it.each(VENUE_SPECS.map(s => [s.name, s] as const))('%s: keyless adapters construct (public market data)', (_name, spec) => {
    for (const kind of venueKinds(spec)) {
      const adapter = buildVenueAdapter(spec, kind)
      expect(typeof adapter.fetchTicker).toBe('function')
      expect(typeof adapter.createOrder).toBe('function')
    }
  })

  it('a credentialed adapter carries key, passphrase and venue options through', () => {
    const okx = VENUE_SPECS.find(s => s.name === 'okx')!
    const okxPerp = buildVenueAdapter(okx, 'exchange/perp', { apiKey: 'k', secret: 's', password: 'p', testnet: true })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const okxExchange = (okxPerp as any).exchange
    expect(okxExchange.timeout).toBe(30_000)
    expect(okxExchange.options.fetchMarkets.types).toEqual(['swap'])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((buildVenueAdapter(okx, 'exchange/spot') as any).exchange.options.fetchMarkets.types).toEqual(['spot'])

    const lighter = VENUE_SPECS.find(s => s.name === 'lighter')!
    expect(() => buildVenueAdapter(lighter, 'exchange/perp', { privateKey: '0xabc', accountIndex: 3, apiKeyIndex: 0 })).not.toThrow()
  })

  it('rejects a kind the venue does not serve', () => {
    const upbit = VENUE_SPECS.find(s => s.name === 'upbit')!   // spot only
    expect(() => buildVenueAdapter(upbit, 'exchange/perp')).toThrow(/does not serve/)
  })

  it('credential schemas reject incomplete input and default the optional fields', () => {
    const okxSchema = credentialSchema('okx')
    expect(() => okxSchema.parse({ apiKey: 'k', secret: 's' })).toThrow()   // passphrase required
    expect(okxSchema.parse({ apiKey: 'k', secret: 's', password: 'p' })).toMatchObject({ testnet: false })

    const bitgetFields = Object.keys(credentialSchema('bitget').shape)
    expect(bitgetFields).not.toContain('testnet')   // no sandbox → no toggle

    const lighterSchema = credentialSchema('lighter')
    expect(lighterSchema.parse({ privateKey: '0xabc', accountIndex: 7 })).toMatchObject({ apiKeyIndex: 0, testnet: false })
  })
})
