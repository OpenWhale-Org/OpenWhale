import { describe, it, expect } from 'vitest'
import {
  priorityP, priorityFeeUsd, decidePriority, autoPriorityBps,
  isPriorityBalanceRejection, PRIORITY_SATURATION_BPS,
} from '../priority.js'

describe('priorityP', () => {
  // The venue reads p / 1e8 as the rate, so a basis point is 10 000. Getting
  // this wrong by a factor of ten is a silent 10x overcharge on every order.
  it('encodes basis points as the venue reads them', () => {
    expect(priorityP(1)).toBe(10_000)
    expect(priorityP(0.5)).toBe(5_000)
    expect(priorityP(1.5)).toBe(15_000)
    expect(priorityP(8)).toBe(80_000)
  })

  it('a full 100% is the venue ceiling', () => {
    expect(priorityP(10_000)).toBe(100_000_000)
  })
})

describe('priorityFeeUsd', () => {
  // Measured live 2026-08-11: 0.00157 BTC filled at 63 810 with 1bp attached
  // burned 0.00018190 HYPE, which at $55.12 is $0.010027 against a $100.18
  // notional — 1.0009 bps. The arithmetic below is that same trade.
  it('matches the fee observed on a real fill', () => {
    expect(priorityFeeUsd(0.00157, 63_810, 1)).toBeCloseTo(0.010018, 6)
  })

  it('scales linearly with size and rate', () => {
    expect(priorityFeeUsd(1, 5_000, 1)).toBeCloseTo(0.5, 9)     // $5k at 1bp
    expect(priorityFeeUsd(1, 5_000, 8)).toBeCloseTo(4.0, 9)     // $5k at 8bp
  })
})

describe('decidePriority', () => {
  const base = { amount: 1, price: 5_000, fallback: true, timeInForce: 'IOC' }

  it('attempts when nothing stands in the way', () => {
    expect(decidePriority({ ...base, bps: 1 })).toEqual({ attempt: true, bps: 1 })
  })

  it('clamps to saturation rather than overcharging', () => {
    // Above 8bps the fee stops buying time, so charging 20 to deliver what 8
    // delivers would be a silent overcharge.
    expect(decidePriority({ ...base, bps: 20 })).toEqual({ attempt: true, bps: PRIORITY_SATURATION_BPS })
  })

  it('does not attempt at a zero or negative rate', () => {
    expect(decidePriority({ ...base, bps: 0 }).attempt).toBe(false)
    expect(decidePriority({ ...base, bps: -1 }).attempt).toBe(false)
  })

  it('an unaffordable fee falls back rather than failing the order', () => {
    // $5k at 1bp = $0.50, budget $0.10.
    const d = decidePriority({ ...base, bps: 1, budgetUsd: 0.1 })
    expect(d.attempt).toBe(false)
    expect(d.fallback).toBe(true)
    expect(d.reason).toMatch(/exceeds budget/)
  })

  it('but fails outright when the caller forbade falling back', () => {
    const d = decidePriority({ ...base, bps: 1, budgetUsd: 0.1, fallback: false })
    expect(d.attempt).toBe(false)
    expect(d.fallback).toBe(false)
  })

  it('no budget means assume there is enough — the venue is the real gate', () => {
    expect(decidePriority({ ...base, bps: 8 }).attempt).toBe(true)
  })

  // Eligibility is the venue's rule: "every order is IOC, or every order is a
  // non-reduce-only ALO". Asking for priority on anything else means the caller
  // believes something false about their own order, so it throws.
  it('rejects GTC — the venue does not price it', () => {
    expect(() => decidePriority({ ...base, bps: 1, timeInForce: 'GTC' })).toThrow(/IOC/)
  })

  // The venue excludes reduce-only from the ALO branch only. On a netting
  // venue every exit is reduce-only, so rejecting it here would make the whole
  // feature unusable for closes — which is the contested moment worth paying for.
  it('accepts a reduce-only IOC — the only shape a close takes on a netting venue', () => {
    expect(decidePriority({ ...base, bps: 1, reduceOnly: true })).toEqual({ attempt: true, bps: 1 })
  })

  it('accepts lowercase tif — ccxt and the venue disagree on casing', () => {
    expect(decidePriority({ ...base, bps: 1, timeInForce: 'Ioc' }).attempt).toBe(true)
  })
})

describe('autoPriorityBps', () => {
  // Spend a third of what the trade nets, never more than saturation.
  it('spends a share of the net edge', () => {
    // fr 30bps − fee 4.5bps = 25.5bps of edge, a third of it is 8.5 → clamped
    expect(autoPriorityBps(0.003, 0.00045)).toBe(PRIORITY_SATURATION_BPS)
    // fr 9bps − fee 4.5bps = 4.5bps of edge, a third is 1.5
    expect(autoPriorityBps(0.0009, 0.00045)).toBeCloseTo(1.5, 9)
  })

  it('pays nothing when the fee eats the funding', () => {
    expect(autoPriorityBps(0.0004, 0.00045)).toBe(0)
    expect(autoPriorityBps(0, 0.00045)).toBe(0)
  })

  it('is symmetric in the sign of the funding rate', () => {
    // The leg is opened against the funding, so a negative rate is collected
    // exactly as a positive one is.
    expect(autoPriorityBps(-0.003, 0.00045)).toBe(autoPriorityBps(0.003, 0.00045))
  })

  it('never exceeds saturation, however fat the funding', () => {
    expect(autoPriorityBps(0.05, 0.00045)).toBe(PRIORITY_SATURATION_BPS)
  })
})

describe('isPriorityBalanceRejection', () => {
  // Verbatim from the venue, captured live 2026-08-11. The fallback path keys
  // off this string, so a change in the venue's wording must fail loudly here
  // rather than quietly turn every settlement leg into a hard failure.
  it('recognises the venue’s wording', () => {
    expect(isPriorityBalanceRejection(
      'hyperliquid {"status":"ok","response":{"type":"order","data":{"statuses":[{"error":"Insufficient delegatable balance for priority order"}]}}}',
    )).toBe(true)
  })

  it('does not swallow an unrelated rejection', () => {
    expect(isPriorityBalanceRejection('Order could not immediately match against any resting orders. asset=0')).toBe(false)
    expect(isPriorityBalanceRejection('Insufficient margin')).toBe(false)
  })
})
