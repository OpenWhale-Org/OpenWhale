/**
 * Order-priority fee arithmetic and policy — the parts worth testing on their own.
 *
 * Hyperliquid prices order sequencing: an order action carrying
 * `grouping: {"p": N}` is sequenced ahead of competing flow in its own action
 * class. The rate is `p / 1e8`, the fee is charged from the UNDELEGATED STAKING
 * balance as a fraction of the filled notional, and it is burned.
 *
 * Everything here is pure. The venue round trip lives in the adapter; the
 * decisions that are easy to get quietly wrong live here, where a worked
 * example can pin them down.
 */

/** Hyperliquid reads the priority rate as `p / 1e8`, so one basis point is 10 000. */
export const PRIORITY_P_PER_BP = 10_000

/**
 * Above this the fee stops buying time.
 *
 * Official: the rate has a linear effect on end-to-end latency from 0-8bps
 * (~45ms per bp). Past 8bps every priority order is treated with identical
 * time preference and the fee only breaks ties. Paying more than this buys
 * nothing unless a rival is also above it.
 */
export const PRIORITY_SATURATION_BPS = 8

/** `p` for a rate in basis points. */
export function priorityP(bps: number): number {
  return Math.round(bps * PRIORITY_P_PER_BP)
}

/** What this order's priority will cost, in USD (the fee is a fraction of filled notional). */
export function priorityFeeUsd(amount: number, price: number, bps: number): number {
  return amount * price * bps / 10_000
}

export interface PriorityDecision {
  /** Send the order with priority. */
  attempt: boolean
  /** Rate actually used, after clamping. Present only when attempting. */
  bps?: number
  /** Why priority was dropped, for the execution record. Absent when attempting. */
  reason?: string
  /** Dropping means place a PLAIN order; not dropping means fail the order outright. */
  fallback?: boolean
}

export interface PriorityRequest {
  bps: number
  amount: number
  price: number
  /** What the caller is willing to spend on priority for this order, USD. Unknown = assume enough. */
  budgetUsd?: number
  /** Place without priority when it cannot be paid (default), or fail the order. */
  fallback: boolean
  timeInForce?: string
  reduceOnly?: boolean
}

/**
 * Whether to attach priority to this order, and at what rate.
 *
 * The eligibility rules are the venue's, quoted from its docs: priority
 * grouping applies only where "every order is IOC, or every order is a
 * non-reduce-only ALO". Only IOC is supported here — the ALO branch charges on
 * the RESTING notional at placement whether or not the order ever fills, and
 * the cohorts observed paying it were net negative.
 *
 * Note where the reduce-only exclusion sits: on the ALO branch alone. A
 * reduce-only IOC is eligible, which matters because it is the ONLY shape a
 * close takes on a netting venue — Hyperliquid has no hedge mode, so every
 * exit there is reduce-only. Rejecting it would leave the feature unusable for
 * exits, which is where the contested moment actually is.
 *
 * An ineligible order is a caller mistake, so it throws rather than silently
 * degrading: asking for priority on a GTC means the caller believes something
 * false about their own order.
 */
export function decidePriority(req: PriorityRequest): PriorityDecision {
  if (!(req.bps > 0)) return { attempt: false, reason: 'priorityBps <= 0', fallback: true }

  if (req.timeInForce !== undefined && req.timeInForce.toUpperCase() !== 'IOC') {
    throw new Error(
      `priorityBps requires an IOC order (got timeInForce=${req.timeInForce}) — the venue supports priority only where "every order is IOC, or every order is a non-reduce-only ALO"`,
    )
  }
  // Clamped, not rejected: a caller asking for 20bps wants "as fast as
  // possible", and charging them 20 to deliver what 8 delivers is a silent
  // overcharge. The clamp is reported so the record shows what was paid.
  const bps = Math.min(req.bps, PRIORITY_SATURATION_BPS)

  if (req.budgetUsd !== undefined) {
    const feeUsd = priorityFeeUsd(req.amount, req.price, bps)
    if (feeUsd > req.budgetUsd) {
      return {
        attempt: false,
        reason: `priority fee $${feeUsd.toFixed(6)} exceeds budget $${req.budgetUsd.toFixed(6)}`,
        fallback: req.fallback,
      }
    }
  }

  return { attempt: true, bps }
}

/**
 * The venue rejected this order for want of priority balance.
 *
 * Verified live (2026-08-11): an order with priority and an empty undelegated
 * stake comes back with "Insufficient delegatable balance for priority order",
 * BEFORE matching is attempted. So the balance is a submission-time gate, not
 * a settlement-time one — which is exactly why the plain-order fallback has to
 * exist: at the settlement instant an empty balance would otherwise take the
 * whole leg down.
 */
export function isPriorityBalanceRejection(message: string): boolean {
  return /insufficient delegatable balance/i.test(message)
}

/**
 * Auto rate for a funding-arb close: spend a share of the edge, never more.
 *
 * The edge being protected is the funding collected minus what it costs to get
 * out. Spending a third of it to be earlier in the exit is a bet that the
 * remaining two thirds are worth protecting from the sell avalanche; spending
 * all of it would be paying exactly what the trade is worth.
 *
 * `fundingRate` and `takerFee` are decimals (0.003 = 30bps); the result is bps,
 * clamped to [0, 8] because nothing above saturation buys time.
 */
export function autoPriorityBps(fundingRate: number, takerFee: number, share = 3): number {
  const netEdgeBps = (Math.abs(fundingRate) - Math.abs(takerFee)) * 10_000
  if (!(netEdgeBps > 0)) return 0
  return Math.min(netEdgeBps / share, PRIORITY_SATURATION_BPS)
}
