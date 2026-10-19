import { describe, it, expect } from 'vitest'
import type { ExchangeFill, FundingEvent } from '@openwhaleorg/exchange'
import { replayFills, attributeFunding, returnPct } from '../history/positionHistory.js'

/**
 * Position history rebuilt from fills, checked against what Binance's own
 * tab showed for the same trades (2026-10-19): SOXS, 25x, closed 67.17 at
 * 51.53 after opening at 51.40415, realized +6.68, ROI +4.84%.
 */

let n = 0
const fill = (o: Partial<ExchangeFill> & { symbol: string; side: 'buy' | 'sell'; qty: number; price: number; timestamp: number }): ExchangeFill => ({
  id: String(++n), orderId: `o${n}`, ...o,
})

describe('one-way mode', () => {
  it('an open and a close is one closed episode with the venue\'s PnL', () => {
    const r = replayFills([
      fill({ symbol: 'SOXS/USDT:USDT', side: 'buy', qty: 67.17, price: 51.40415, timestamp: 1000, fee: 0.69, feeAsset: 'USDT' }),
      fill({ symbol: 'SOXS/USDT:USDT', side: 'sell', qty: 67.17, price: 51.53, timestamp: 2000, realizedPnl: 6.68, fee: 0.69, feeAsset: 'USDT' }),
    ], false)
    expect(r.open).toEqual([])
    expect(r.closed).toHaveLength(1)
    const e = r.closed[0]!
    expect(e.direction).toBe('long')
    expect(e.openAvg).toBeCloseTo(51.40415, 6)
    expect(e.closeAvg).toBeCloseTo(51.53, 6)
    expect(e.closedQty).toBeCloseTo(67.17)
    expect(e.maxQty).toBeCloseTo(67.17)
    expect(e.tradePnl).toBeCloseTo(6.68)
    expect(e.fees['USDT']).toBeCloseTo(1.38)
    expect(e.volume).toBeCloseTo(67.17 * 51.40415 + 67.17 * 51.53)
    expect(e.openedAt).toBe(1000)
    expect(e.closedAt).toBe(2000)
    expect(returnPct(e, 25)).toBeCloseTo(4.84, 1)
  })

  it('adds raise the average and the max; partial closes keep the episode open', () => {
    const r = replayFills([
      fill({ symbol: 'X/USDT:USDT', side: 'sell', qty: 10, price: 100, timestamp: 1 }),
      fill({ symbol: 'X/USDT:USDT', side: 'sell', qty: 10, price: 110, timestamp: 2 }),
      fill({ symbol: 'X/USDT:USDT', side: 'buy', qty: 5, price: 90, timestamp: 3, realizedPnl: 75 }),
    ], false)
    expect(r.closed).toEqual([])
    const e = r.open[0]!
    expect(e.direction).toBe('short')
    expect(e.openAvg).toBeCloseTo(105)
    expect(e.maxQty).toBe(20)
    expect(e.remainingQty).toBe(15)
    expect(e.closedQty).toBe(5)
    expect(e.tradePnl).toBe(75)
    expect(e.status).toBe('open')
  })

  it('a fill that overshoots the net closes one episode and opens the next at that price', () => {
    const r = replayFills([
      fill({ symbol: 'X/USDT:USDT', side: 'buy', qty: 10, price: 100, timestamp: 1 }),
      fill({ symbol: 'X/USDT:USDT', side: 'sell', qty: 15, price: 120, timestamp: 2, realizedPnl: 200, fee: 1.5, feeAsset: 'USDT' }),
    ], false)
    expect(r.closed).toHaveLength(1)
    expect(r.open).toHaveLength(1)
    const done = r.closed[0]!, next = r.open[0]!
    expect(done.direction).toBe('long')
    expect(done.closedQty).toBe(10)
    expect(done.tradePnl).toBe(200)
    expect(done.fees['USDT']).toBeCloseTo(1.0)
    expect(done.volume).toBe(10 * 100 + 10 * 120)
    expect(next.volume).toBe(5 * 120)
    expect(next.direction).toBe('short')
    expect(next.openedQty).toBe(5)
    expect(next.openAvg).toBe(120)
    expect(next.fees['USDT']).toBeCloseTo(0.5)
    expect(next.openedAt).toBe(2)
  })

  it('a close with no opening in hand is a truncated episode, not a new position', () => {
    const r = replayFills([
      fill({ symbol: 'X/USDT:USDT', side: 'sell', qty: 3, price: 50, timestamp: 1, realizedPnl: -4 }),
      fill({ symbol: 'X/USDT:USDT', side: 'buy', qty: 1, price: 40, timestamp: 2 }),
    ], false)
    expect(r.closed).toHaveLength(1)
    expect(r.closed[0]!.truncated).toBe(true)
    expect(r.closed[0]!.direction).toBe('long')
    expect(r.closed[0]!.tradePnl).toBe(-4)
    expect(r.open).toHaveLength(1)
    expect(r.open[0]!.direction).toBe('long')
    expect(r.open[0]!.truncated).toBe(false)
  })
})

describe('hedge mode', () => {
  const hedged = (side: 'LONG' | 'SHORT', o: Parameters<typeof fill>[0]) => fill({ ...o, info: { positionSide: side } })

  it('LONG and SHORT on one contract are separate books', () => {
    const r = replayFills([
      hedged('LONG', { symbol: 'Y/USDT:USDT', side: 'buy', qty: 2, price: 10, timestamp: 1 }),
      hedged('SHORT', { symbol: 'Y/USDT:USDT', side: 'sell', qty: 2, price: 10, timestamp: 2 }),
      hedged('LONG', { symbol: 'Y/USDT:USDT', side: 'sell', qty: 2, price: 11, timestamp: 3, realizedPnl: 2 }),
    ], true)
    expect(r.closed).toHaveLength(1)
    expect(r.closed[0]!.positionSide).toBe('LONG')
    expect(r.closed[0]!.tradePnl).toBe(2)
    expect(r.open).toHaveLength(1)
    expect(r.open[0]!.positionSide).toBe('SHORT')
    expect(r.open[0]!.direction).toBe('short')
  })

  it('a closing-side fill with nothing held is recognised without needing PnL', () => {
    const r = replayFills([
      hedged('SHORT', { symbol: 'Y/USDT:USDT', side: 'buy', qty: 1, price: 10, timestamp: 1 }),
    ], true)
    expect(r.closed[0]!.truncated).toBe(true)
    expect(r.closed[0]!.direction).toBe('short')
  })
})

describe('funding', () => {
  it('goes to the episode that held the contract at the time; the rest is returned', () => {
    const r = replayFills([
      fill({ symbol: 'Z/USDT:USDT', side: 'buy', qty: 1, price: 1, timestamp: 100 }),
      fill({ symbol: 'Z/USDT:USDT', side: 'sell', qty: 1, price: 1, timestamp: 200, realizedPnl: 0 }),
      fill({ symbol: 'Z/USDT:USDT', side: 'buy', qty: 1, price: 1, timestamp: 300 }),
    ], false)
    const ev = (timestamp: number, amount: number): FundingEvent => ({ symbol: 'Z/USDT:USDT', amount, asset: 'USDT', timestamp })
    const orphans = attributeFunding(r, [ev(150, -0.5), ev(250, 9), ev(350, 0.25)])
    expect(r.closed[0]!.funding).toBe(-0.5)
    expect(r.open[0]!.funding).toBe(0.25)
    expect(orphans).toEqual([ev(250, 9)])
  })
})

describe('venues that report no PnL per fill', () => {
  it('take the position\'s own arithmetic and say so', () => {
    const r = replayFills([
      fill({ symbol: 'X/USDT:USDT', side: 'sell', qty: 10, price: 100, timestamp: 1 }),
      fill({ symbol: 'X/USDT:USDT', side: 'sell', qty: 10, price: 110, timestamp: 2 }),
      fill({ symbol: 'X/USDT:USDT', side: 'buy', qty: 20, price: 90, timestamp: 3 }),
    ], false)
    const e = r.closed[0]!
    expect(e.tradePnl).toBeCloseTo((105 - 90) * 20)
    expect(e.estimatedPnl).toBe(true)
  })

  it('a venue number is never overridden', () => {
    const r = replayFills([
      fill({ symbol: 'X/USDT:USDT', side: 'buy', qty: 1, price: 100, timestamp: 1 }),
      fill({ symbol: 'X/USDT:USDT', side: 'sell', qty: 1, price: 120, timestamp: 2, realizedPnl: 19.5 }),
    ], false)
    expect(r.closed[0]!.tradePnl).toBe(19.5)
    expect(r.closed[0]!.estimatedPnl).toBe(false)
  })
})
