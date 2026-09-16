import { describe, it, expect } from 'vitest'
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto'
import { binanceKeyKind, binanceSigningSecret, normalizeEd25519Pem, signBinanceQuery } from '../keys.js'
import { BinanceAdapter } from '../adapter.js'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()

describe('Ed25519 keys', () => {
  it('survives what copy-paste does to a PEM', () => {
    const oneLine = PEM.replace(/\n/g, ' ')
    const crlf = `  ${PEM.replace(/\n/g, '\r\n')}  `
    expect(normalizeEd25519Pem(oneLine)).toBe(PEM)
    expect(normalizeEd25519Pem(crlf)).toBe(PEM)
    // ccxt tells Ed25519 from RSA by length: over 120 characters is RSA.
    expect(normalizeEd25519Pem(oneLine).length).toBeLessThanOrEqual(120)
  })

  it('says so when handed the public key or an RSA key', () => {
    expect(() => normalizeEd25519Pem(PUBLIC_PEM)).toThrow(/PUBLIC key/)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => normalizeEd25519Pem(rsa)).toThrow(/Ed25519/)
    expect(() => normalizeEd25519Pem('not a key')).toThrow(/BEGIN PRIVATE KEY/)
  })

  it('a credential signs with exactly one of its two secrets', () => {
    expect(binanceSigningSecret({ apiKey: 'k', secret: 'abc' })).toBe('abc')
    expect(binanceSigningSecret({ apiKey: 'k', privateKey: PEM })).toBe(PEM)
    expect(() => binanceSigningSecret({ apiKey: 'k', secret: 'abc', privateKey: PEM })).toThrow(/not both/)
    expect(() => binanceSigningSecret({ apiKey: 'k' })).toThrow(/needs/)
    expect(binanceKeyKind(PEM)).toBe('ed25519')
    expect(binanceKeyKind('abc')).toBe('hmac')
  })

  it('signs a query the way Binance verifies it, and the same way ccxt does', async () => {
    const query = 'symbol=BTCUSDT&side=BUY&type=MARKET&quantity=0.001&timestamp=1789600000000'
    const signature = decodeURIComponent(signBinanceQuery(query, PEM))
    expect(verify(null, Buffer.from(query), createPublicKey(PUBLIC_PEM), Buffer.from(signature, 'base64'))).toBe(true)

    // ccxt signs the body it builds (with its own extra params); ours must
    // produce the identical signature for that same query.
    const adapter = new BinanceAdapter({ apiKey: 'k', secret: PEM })
    const ex = (adapter as unknown as { exchange: { sign(path: string, api: string, method: string, params: Record<string, unknown>): { body: string } } }).exchange
    const { body } = ex.sign('order', 'fapiPrivate', 'POST', { symbol: 'BTCUSDT', timestamp: 1789600000000 })
    const at = body.indexOf('&signature=')
    expect(at).toBeGreaterThan(0)
    expect(signBinanceQuery(body.slice(0, at), PEM)).toBe(body.slice(at + '&signature='.length))
  })

  it('HMAC keys keep their hex signatures', () => {
    expect(signBinanceQuery('a=1', 'secret')).toMatch(/^[0-9a-f]{64}$/)
  })
})
