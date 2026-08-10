import { describe, it, expect, vi, afterEach } from 'vitest'
import path from 'path'

/**
 * Monitor key encoding is platform-gated: Windows percent-encodes the reserved
 * set (so `:` etc. can land on an NTFS filesystem), POSIX passes keys through
 * verbatim (so existing stores with `/` nested-directories keep working).
 *
 * The constant that decides is read once at module load, so each platform case
 * reloads the module under a different `process.platform`.
 */
async function loadPaths(platform: string): Promise<typeof import('../paths.js')> {
  vi.resetModules()
  const real = process.platform
  // process.platform is a read-only accessor at runtime, so redefine it rather
  // than assign. Restored in finally so later tests see the real platform.
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await import('../paths.js')
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true })
  }
}

// Real keys the store sees in production, plus the two adversarial ones from the
// PR review that defeat non-percent encodings.
const KEYS = [
  'hyperliquid:BTC/USDC:USDC:1m',
  'binance:BTC/USDT:USDT:1h',
  'kucoin-futures:XRP/USDT:USDT',
  'hyperliquid:0xabcdef1234567890',          // a wallet address (user-trades)
  // Adversarial: tokens that a naive __ / -- encoding cannot round-trip.
  'x_:y',        // underscore immediately before a colon
  'a--b:c',      // a literal double-dash inside the key
  'p%q',         // a literal percent sign
  'sym\\*?"<>|', // every other Windows-illegal char at once
]

describe('encodeMonitorKey / decodeMonitorKey', () => {
  afterEach(() => { vi.resetModules() })

  it('round-trips every key on win32', async () => {
    const { encodeMonitorKey, decodeMonitorKey } = await loadPaths('win32')
    for (const key of KEYS) {
      const encoded = encodeMonitorKey(key)
      // The encoded form must not carry the Windows-illegal chars verbatim.
      expect(encoded).not.toMatch(/[:\\*?"<>|]/)
      // ...and it must decode back to the original, exactly.
      expect(decodeMonitorKey(encoded)).toBe(key)
    }
  })

  it('is the identity on POSIX (keys pass through verbatim)', async () => {
    const { encodeMonitorKey, decodeMonitorKey } = await loadPaths('linux')
    for (const key of KEYS) {
      expect(encodeMonitorKey(key)).toBe(key)
      expect(decodeMonitorKey(key)).toBe(key)
    }
  })

  it('win32 encoding produces no path separators in the filename', async () => {
    const { encodeMonitorKey } = await loadPaths('win32')
    for (const key of KEYS) {
      const encoded = encodeMonitorKey(key)
      expect(encoded).not.toContain('/')
      expect(encoded).not.toContain('\\')
    }
  })

  it('win32 encodes the documented reserved set', async () => {
    const { encodeMonitorKey } = await loadPaths('win32')
    // Percent first, then the rest — spot-check the actual tokens.
    expect(encodeMonitorKey('a:b')).toBe('a%3Ab')
    expect(encodeMonitorKey('a/b')).toBe('a%2Fb')
    expect(encodeMonitorKey('100%')).toBe('100%25')
  })

  it('win32 decode fails soft on a malformed percent-escape (foreign file name)', async () => {
    const { decodeMonitorKey } = await loadPaths('win32')
    // keys() / walkJsonl feed raw filesystem names in; a stray/half-written file
    // must not throw and take out the whole listing — it returns verbatim.
    expect(decodeMonitorKey('100%')).toBe('100%')
    expect(decodeMonitorKey('50%off')).toBe('50%off')
    // A well-formed escape still decodes.
    expect(decodeMonitorKey('a%3Ab')).toBe('a:b')
  })

  it('getMonitorPath encodes only the key segment on win32', async () => {
    const { getMonitorPath } = await loadPaths('win32')
    const p = getMonitorPath('/data', 'klines', 'hyperliquid:BTC/USDC:USDC:1m')
    // Assert on the basename only: path.join binds to the HOST platform at module
    // load, so redefining process.platform does not flip '/' to '\' on POSIX.
    // The thing under test is the encoded filename stem, not the separator.
    expect(path.basename(p)).toBe('hyperliquid%3ABTC%2FUSDC%3AUSDC%3A1m.jsonl')
    expect(p).toContain('klines')   // monitorName is NOT encoded
  })
})
