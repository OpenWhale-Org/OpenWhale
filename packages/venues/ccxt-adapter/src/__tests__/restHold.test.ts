import { describe, it, expect, beforeEach } from 'vitest'
import { gateRequests, holdFromResponse, restHeldUntil, resetRestHolds, VenueHeldError } from '../restHold.js'

/**
 * A venue that said stop is not asked again until the time it named.
 *
 * 2026-10-14: Binance's 418 named a two-minute ban; this process kept
 * sending through it — monitor restarts, a six-hundred-call fills sweep —
 * and each request pushed the ban out. Forty-four minutes, then sixty-six
 * the next day. The hold makes the venue's answer the whole process's answer.
 */

const BAN_BODY = '{"code":-1003,"msg":"Way too many requests; IP(13.0.0.1) banned until 1791983690384. Please use the websocket for live updates to avoid bans."}'

function fakeExchange(id = 'binanceusdm') {
  const ex = {
    id,
    sent: [] as string[],
    onRestResponse(_status: number, _text: string, _url: string, _method: string, _headers: Record<string, string>, body: string) { return body },
    async fetch2(path: string) { ex.sent.push(path); return { ok: true } },
    answer(status: number, headers: Record<string, string>, body: string) {
      ex.onRestResponse(status, '', 'https://fapi.binance.com/x', 'GET', headers, body)
    },
  }
  return gateRequests(ex)
}

beforeEach(() => resetRestHolds())

describe('reading the venue\'s answer', () => {
  it('a 418 ban body names the ban end, in ms', () => {
    const hold = holdFromResponse('binanceusdm', 418, { 'Retry-After': '55' }, BAN_BODY, 1_791_983_600_000)
    expect(hold).toEqual({ until: 1791983690384, reason: '418 IP banned' })
  })
  it('a 429 holds for Retry-After seconds', () => {
    const hold = holdFromResponse('binanceusdm', 429, { 'Retry-After': '12' }, '{"code":-1003}', 1_000_000)
    expect(hold).toEqual({ until: 1_012_000, reason: '429 Retry-After 12s' })
  })
  it('a Binance 429 with nothing to go on waits out the minute', () => {
    expect(holdFromResponse('binanceusdm', 429, {}, '', 1_000_000)?.until).toBe(1_060_000)
  })
  it('a bare 429 elsewhere is one failed call, not a hold', () => {
    expect(holdFromResponse('hyperliquid', 429, {}, '', 1_000_000)).toBeUndefined()
    expect(holdFromResponse('hyperliquid', 429, { 'Retry-After': '3' }, '', 1_000_000)?.until).toBe(1_003_000)
  })
  it('other statuses hold nothing', () => {
    expect(holdFromResponse('binanceusdm', 200, {}, BAN_BODY)).toBeUndefined()
    expect(holdFromResponse('binanceusdm', 400, {}, '{"code":-1111}')).toBeUndefined()
  })
})

describe('the gate', () => {
  it('fails every REST call locally while the venue is held', async () => {
    const ex = fakeExchange()
    const until = Date.now() + 90_000
    ex.answer(418, { 'Retry-After': '90' }, BAN_BODY.replace('1791983690384', String(until)))

    await expect(ex.fetch2('/fapi/v1/userTrades')).rejects.toBeInstanceOf(VenueHeldError)
    expect(ex.sent).toEqual([])
    expect(restHeldUntil('binanceusdm')).toBe(until + 1_000)
    const err = await ex.fetch2('/fapi/v1/time').catch((e: unknown) => e) as VenueHeldError
    expect(err.retryable).toBe(true)
    expect(err.heldUntil).toBe(until + 1_000)
  })

  it('is per venue: a Binance ban does not hold Hyperliquid', async () => {
    const binance = fakeExchange('binanceusdm')
    const hl = fakeExchange('hyperliquid')
    binance.answer(429, { 'Retry-After': '30' }, '')
    await expect(hl.fetch2('/info')).resolves.toEqual({ ok: true })
    expect(restHeldUntil('hyperliquid')).toBeUndefined()
  })

  it('lets calls through again once the time has passed', async () => {
    const ex = fakeExchange()
    ex.answer(418, {}, BAN_BODY.replace('1791983690384', String(Date.now() - 5_000)))
    await expect(ex.fetch2('/fapi/v1/time')).resolves.toEqual({ ok: true })
    expect(restHeldUntil('binanceusdm')).toBeUndefined()
  })

  it('a later answer extends the hold; an earlier one does not shorten it', () => {
    const ex = fakeExchange()
    const far = Date.now() + 600_000
    ex.answer(418, {}, BAN_BODY.replace('1791983690384', String(far)))
    ex.answer(429, { 'Retry-After': '5' }, '')
    expect(restHeldUntil('binanceusdm')).toBe(far + 1_000)
    ex.answer(418, {}, BAN_BODY.replace('1791983690384', String(far + 120_000)))
    expect(restHeldUntil('binanceusdm')).toBe(far + 121_000)
  })
})
