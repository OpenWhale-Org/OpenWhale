import { describe, it, expect, afterEach } from 'vitest'
import { CcxtAdapter } from '../CcxtAdapter.js'

/**
 * Outbound proxy wiring.
 *
 * Worth testing at all because the failure it guards against is silent in both
 * directions: forget to apply the proxy and a whole region cannot reach any
 * venue, apply it where the caller already set one and ccxt throws
 * InvalidProxySettings at construction — for every venue at once.
 *
 * `exchange` is protected, so read it through a subclass rather than a cast:
 * the test then breaks if that field is ever renamed, which is the point.
 */
class Probe extends CcxtAdapter {
  proxies(): Record<string, unknown> {
    const e = this.exchange as unknown as Record<string, unknown>
    return {
      httpsProxy: e['httpsProxy'], wssProxy: e['wssProxy'],
      socksProxy: e['socksProxy'], wsSocksProxy: e['wsSocksProxy'],
      httpProxy: e['httpProxy'],
    }
  }
}

const ENV = ['OPENWHALE_HTTPS_PROXY', 'OPENWHALE_HTTPS_PROXY_BINANCEUSDM', 'OPENWHALE_HTTPS_PROXY_OKX']
afterEach(() => { for (const k of ENV) delete process.env[k] })

describe('CcxtAdapter — outbound proxy', () => {
  it('applies nothing when no proxy is configured', () => {
    const p = new Probe({ exchangeId: 'binanceusdm' }).proxies()
    expect(p.httpsProxy).toBeUndefined()
    expect(p.wssProxy).toBeUndefined()
  })

  it('covers REST and WebSocket from one setting', () => {
    const p = new Probe({ exchangeId: 'binanceusdm', proxy: 'http://127.0.0.1:7897' }).proxies()
    // ccxt validates the two groups separately, so both may be set at once —
    // and both must be, or live data stays broken while credentials work.
    expect(p.httpsProxy).toBe('http://127.0.0.1:7897')
    expect(p.wssProxy).toBe('http://127.0.0.1:7897')
  })

  it('routes a socks:// url to the socks keys, not the https ones', () => {
    const p = new Probe({ exchangeId: 'okx', proxy: 'socks5://127.0.0.1:1080' }).proxies()
    expect(p.socksProxy).toBe('socks5://127.0.0.1:1080')
    expect(p.wsSocksProxy).toBe('socks5://127.0.0.1:1080')
    expect(p.httpsProxy).toBeUndefined()
  })

  it('falls back to the global environment variable', () => {
    process.env['OPENWHALE_HTTPS_PROXY'] = 'http://gw:3128'
    expect(new Probe({ exchangeId: 'okx' }).proxies().httpsProxy).toBe('http://gw:3128')
  })

  it('lets a venue override the global one', () => {
    process.env['OPENWHALE_HTTPS_PROXY'] = 'http://gw:3128'
    process.env['OPENWHALE_HTTPS_PROXY_BINANCEUSDM'] = 'http://direct-line:8080'
    expect(new Probe({ exchangeId: 'binanceusdm' }).proxies().httpsProxy).toBe('http://direct-line:8080')
    expect(new Probe({ exchangeId: 'okx' }).proxies().httpsProxy).toBe('http://gw:3128')
  })

  /* The reason the per-venue layer exists: this system races settlements by the
     millisecond, so a venue that IS reachable directly must be able to opt out
     of a global proxy aimed at the ones that are not. */
  it('lets a venue opt OUT with `off`, global proxy or not', () => {
    process.env['OPENWHALE_HTTPS_PROXY'] = 'http://gw:3128'
    process.env['OPENWHALE_HTTPS_PROXY_BINANCEUSDM'] = 'off'
    expect(new Probe({ exchangeId: 'binanceusdm' }).proxies().httpsProxy).toBeUndefined()
    expect(new Probe({ exchangeId: 'okx' }).proxies().httpsProxy).toBe('http://gw:3128')
  })

  /* ccxt throws InvalidProxySettings when a group carries two proxies, so the
     fallback must stand down per group rather than all-or-nothing. */
  it('never fights a proxy the caller already set', () => {
    process.env['OPENWHALE_HTTPS_PROXY'] = 'http://gw:3128'
    const p = new Probe({
      exchangeId: 'okx',
      ccxtOptions: { httpProxy: 'http://caller:9000' },   // REST group taken
    }).proxies()
    expect(p.httpProxy).toBe('http://caller:9000')
    expect(p.httpsProxy).toBeUndefined()                 // stood down
    expect(p.wssProxy).toBe('http://gw:3128')            // WS group was free
  })

  it('an explicit option beats every environment variable', () => {
    process.env['OPENWHALE_HTTPS_PROXY'] = 'http://gw:3128'
    process.env['OPENWHALE_HTTPS_PROXY_OKX'] = 'http://venue:3128'
    expect(new Probe({ exchangeId: 'okx', proxy: '' }).proxies().httpsProxy).toBeUndefined()
  })
})
