import { describe, it, expect, afterEach } from 'vitest'
import { CcxtAdapter } from '../CcxtAdapter.js'

/**
 * Reading the account's position mode is expensive in a way that does not look
 * expensive: Aster prices GET /fapi/v3/positionSide/dual at weight 30, and
 * ccxt's leaky bucket charges that as ~10 seconds of the account's budget —
 * paid not by the read, which goes through at once, but by the next request in
 * the queue. Asked before every close, the bill landed on the closing order:
 * measured on a live pair, opens took 0.8s and closes 10s and 20s.
 *
 * So: read once, share the read, and forget it only when the venue says the
 * mode has changed under us.
 */

class Probe extends CcxtAdapter {
  calls = 0
  mode = { hedged: true }
  /** Resolves the next read only when the test says so. */
  gate: (() => void) | undefined

  constructor(exchangeId: string) {
    super({ exchangeId })
    const e = this.exchange as unknown as Record<string, unknown>
    e['has'] = { ...(e['has'] as object), fetchPositionMode: true }
    e['fetchPositionMode'] = async () => {
      this.calls++
      if (this.gate) await new Promise<void>(resolve => { this.gate = resolve })
      return this.mode
    }
  }

  forget(): void { this.forgetPositionMode() }
}

describe('CcxtAdapter — the account position mode', () => {
  it('asks the venue once and answers the rest from the cache', async () => {
    const p = new Probe('binanceusdm')
    expect(await p.fetchPositionMode('BTC/USDT:USDT')).toEqual({ hedged: true })
    expect(await p.fetchPositionMode('ETH/USDT:USDT')).toEqual({ hedged: true })
    expect(await p.fetchPositionMode()).toEqual({ hedged: true })
    // Account-wide state: a second symbol is not a second question.
    expect(p.calls).toBe(1)
  })

  it('shares one read between callers that ask at the same time', async () => {
    const p = new Probe('binanceusdm')
    p.gate = () => {}   // arm: the read parks until released
    const both = Promise.all([p.fetchPositionMode('A/USDT:USDT'), p.fetchPositionMode('B/USDT:USDT')])
    await new Promise(r => setTimeout(r, 0))
    p.gate?.()          // release
    expect(await both).toEqual([{ hedged: true }, { hedged: true }])
    // Two legs closing together on one account is exactly the case that cost
    // twenty seconds: one asked, the other waited behind its bill.
    expect(p.calls).toBe(1)
  })

  it('asks again once the mode is forgotten', async () => {
    const p = new Probe('binanceusdm')
    await p.fetchPositionMode()
    p.mode = { hedged: false }
    p.forget()
    expect(await p.fetchPositionMode()).toEqual({ hedged: false })
    expect(p.calls).toBe(2)
  })

  it('answers one-way without asking on a venue that cannot report it', async () => {
    const p = new Probe('binanceusdm')
    const e = p['exchange'] as unknown as Record<string, unknown>
    e['has'] = { ...(e['has'] as object), fetchPositionMode: false }
    expect(await p.fetchPositionMode()).toEqual({ hedged: false })
    expect(p.calls).toBe(0)
  })
})

/**
 * The pacing an operator can set without a deploy. It belongs to the account's
 * traffic and the venue's published limits, not to any one caller: sessions are
 * cached per credential, so one bucket serves every executor and monitor on it.
 */
class Paced extends CcxtAdapter {
  rate(): { rateLimit: number; enabled: boolean } {
    const e = this.exchange as unknown as { rateLimit: number; enableRateLimit: boolean }
    return { rateLimit: e.rateLimit, enabled: e.enableRateLimit }
  }
}

const RATE_ENV = ['OPENWHALE_RATE_LIMIT_MS', 'OPENWHALE_RATE_LIMIT_MS_BINANCEUSDM']
afterEach(() => { for (const k of RATE_ENV) delete process.env[k] })

describe('CcxtAdapter — client-side pacing', () => {
  it('takes the venue package default when nothing overrides it', () => {
    expect(new Paced({ exchangeId: 'binanceusdm', rateLimitMs: 30 }).rate()).toEqual({ rateLimit: 30, enabled: true })
  })

  it('lets the environment outrank it, per venue before the blanket value', () => {
    process.env['OPENWHALE_RATE_LIMIT_MS'] = '40'
    expect(new Paced({ exchangeId: 'binanceusdm', rateLimitMs: 30 }).rate().rateLimit).toBe(40)
    process.env['OPENWHALE_RATE_LIMIT_MS_BINANCEUSDM'] = '15'
    expect(new Paced({ exchangeId: 'binanceusdm', rateLimitMs: 30 }).rate().rateLimit).toBe(15)
  })

  it('turns the queue off at 0 — the caller then owns the venue\'s limits', () => {
    process.env['OPENWHALE_RATE_LIMIT_MS'] = '0'
    expect(new Paced({ exchangeId: 'binanceusdm', rateLimitMs: 30 }).rate().enabled).toBe(false)
  })

  it('keeps the default when the value is not a number', () => {
    process.env['OPENWHALE_RATE_LIMIT_MS'] = 'fast'
    expect(new Paced({ exchangeId: 'binanceusdm', rateLimitMs: 30 }).rate().rateLimit).toBe(30)
  })
})
