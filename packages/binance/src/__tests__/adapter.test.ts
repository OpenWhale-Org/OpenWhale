import { describe, it, expect } from 'vitest'
import { BinanceAdapter } from '../adapter.js'
import { binancePlugin } from '../plugin.js'
import type { CredentialStore } from '@openwhaleorg/core'

const credentialStore = {} as CredentialStore

describe('BinanceAdapter unified account (Portfolio Margin)', () => {
  it('defaults to the classic account structure', () => {
    const adapter = new BinanceAdapter({ apiKey: 'k', secret: 's' })
    expect(adapter.isUnifiedAccount).toBe(false)
  })

  it('flips ccxt to the papi endpoints when unifiedAccount is set', () => {
    const adapter = new BinanceAdapter({ apiKey: 'k', secret: 's', unifiedAccount: true })
    expect(adapter.isUnifiedAccount).toBe(true)
    // ccxt reads this exact option in every private method's papi routing
    expect((adapter as unknown as { exchange: { options: Record<string, unknown> } }).exchange.options['portfolioMargin']).toBe(true)
  })

  it('rejects unifiedAccount + testnet — Portfolio Margin has no testnet', () => {
    expect(() => new BinanceAdapter({ apiKey: 'k', secret: 's', unifiedAccount: true, testnet: true }))
      .toThrow(/no testnet/)
  })
})

describe('binance credential schema', () => {
  it('exposes the unifiedAccount toggle and wires it into the adapter cell', () => {
    const plugin = binancePlugin({ credentials: credentialStore, config: {} })
    const type = plugin.credentialTypes![0]!
    expect(Object.keys(type.schema!.shape)).toContain('unifiedAccount')

    const cell = plugin.adapters!.find(a => a.kind === 'exchange/perp')!
    const session = cell.create({ apiKey: 'k', secret: 's', unifiedAccount: true }) as BinanceAdapter
    expect(session.isUnifiedAccount).toBe(true)
    // Omitted → classic account, no surprises for existing credentials
    expect((cell.create({ apiKey: 'k', secret: 's' }) as BinanceAdapter).isUnifiedAccount).toBe(false)
    // Keyless form = the public ccxt adapter (mainnet market data)
    expect(cell.create()).not.toBeInstanceOf(BinanceAdapter)
  })
})
