import { describe, it, expect } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { AsterAdapter, AsterPublicAdapter } from '../adapter.js'
import { asterPlugin } from '../plugin.js'

/**
 * Aster authenticates with an API WALLET: ccxt 4.5.52 removed the HMAC path,
 * so a credential still carrying apiKey/secret cannot sign anything. These pin
 * the shape of what the adapter hands ccxt — no network.
 */

/** A throwaway key (Hardhat account #1); only its derived address matters. */
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const MASTER = '0x35a5B33Be664B09F78b5089eb6185f71c8a7f11f'

const ccxtOf = (a: AsterAdapter) =>
  (a as unknown as { exchange: { walletAddress?: string; privateKey?: string; options: Record<string, unknown> } }).exchange

describe('Aster credentials', () => {
  it('signs with the API wallet key and derives its address as the signer', () => {
    const e = ccxtOf(new AsterAdapter({ walletAddress: MASTER, privateKey: KEY }))
    expect(e.walletAddress).toBe(MASTER)
    expect(e.privateKey).toBe(KEY)
    // ccxt throws "requires signerAddress in options when use v3 api" without this
    expect(e.options['signerAddress']).toBe(privateKeyToAccount(KEY).address)
  })

  it('takes a key without the 0x prefix, and an explicit signer wins over the derived one', () => {
    const signerAddress = '0x1F5877C19e3777Cfd15F9d57253eA4aA5254Ec39'
    const e = ccxtOf(new AsterAdapter({ walletAddress: MASTER, privateKey: KEY.slice(2), signerAddress }))
    expect(e.privateKey).toBe(KEY)
    expect(e.options['signerAddress']).toBe(signerAddress)
  })

  it('refuses an old API key / secret credential, and says what to do', () => {
    const legacy = { apiKey: 'k', secret: 's' } as unknown as { walletAddress: string; privateKey: string }
    expect(() => new AsterAdapter(legacy)).toThrow(/API wallet/i)
  })

  it('refuses a key that is not 64 hex characters', () => {
    expect(() => new AsterAdapter({ walletAddress: MASTER, privateKey: '0xdeadbeef' })).toThrow(/64 hex/)
  })

  it('refuses the testnet flag — Aster has no sandbox', () => {
    expect(() => new AsterAdapter({ walletAddress: MASTER, privateKey: KEY, testnet: true })).toThrow(/no testnet/i)
  })

  it('declares the API wallet fields on the credential type, and no apiKey', () => {
    const type = asterPlugin({} as never).credentialTypes?.find(t => t.type === 'aster')
    const shape = Object.keys((type?.schema as unknown as { shape: Record<string, unknown> }).shape)
    expect(shape).toEqual(['walletAddress', 'privateKey', 'signerAddress'])
  })
})

/**
 * The client-side queue is ours, not the venue's, and it was thirteen times
 * tighter than what Aster publishes for itself (2400 weight/minute in
 * exchangeInfo — 25ms a unit). ccxt's bucket bills the NEXT request for the
 * last one's weight, so that gap is what turned a weight-30 read into a
 * ten-second wait on the order behind it.
 */
describe('the client-side rate limit follows the venue, not ccxt\'s default', () => {
  it('paces at the published budget instead of 333ms a unit', () => {
    const probe = new AsterAdapter({ walletAddress: MASTER, privateKey: KEY }) as unknown as {
      exchange: { rateLimit: number; enableRateLimit: boolean }
    }
    expect(probe.exchange.rateLimit).toBe(30)
    // Still queued, though: 429 on repeat is a 418 IP ban, and this engine is
    // not the only thing on the address.
    expect(probe.exchange.enableRateLimit).toBe(true)
  })
})


/**
 * A perp adapter that reads the spot wallet reports an account with $112 of
 * futures positions as having $-0.03 of equity — which is what the accounts
 * page drew, because ccxt's aster ships defaultType 'spot' and nothing here
 * said otherwise. Calls naming a symbol were fine; the balance takes none.
 */
describe('typeless calls mean the futures account', () => {
  it('sets defaultType on the credentialled adapter', () => {
    expect(ccxtOf(new AsterAdapter({ walletAddress: MASTER, privateKey: KEY })).options['defaultType']).toBe('swap')
  })

  it('sets it on the public one too', () => {
    const e = (new AsterPublicAdapter() as unknown as { exchange: { options: Record<string, unknown> } }).exchange
    expect(e.options['defaultType']).toBe('swap')
  })
})
