import type { ExchangePosition, ExchangeOrder, FundingRateData, OpenInterestData, PerpOrderParams } from './exchange.js'
import type { SpotExchangeAdapter } from './spot.js'

/** One leverage bracket: positions up to maxNotionalUsd may use up to maxLeverage. */
export interface LeverageTier {
  /** Notional ceiling of this bracket (USD); Infinity for the last one. */
  maxNotionalUsd: number
  maxLeverage: number
}

/**
 * Perpetual futures exchange adapter.
 *
 * Extends SpotExchangeAdapter with perp-specific interfaces:
 * funding rate queries, position management, and leverage/margin mode configuration.
 *
 * createOrder parameter is upgraded to PerpOrderParams, supporting reduceOnly and timeInForce.
 *
 * Known implementations:
 * - HyperliquidAdapter (packages/hyperliquid)
 */
export interface PerpExchangeAdapter extends SpotExchangeAdapter {
  /**
   * True when the venue runs dual-side (hedge-mode) accounts and orders may
   * carry PerpOrderParams.positionSide. Netting venues (e.g. Hyperliquid)
   * report false — callers must degrade to net-position semantics.
   */
  readonly supportsPositionSide?: boolean

  // ── Market data (perp-specific) ───────────────────────────────────────────

  /**
   * Fetch the current funding rate for a single contract.
   * Note: some exchanges (e.g. Hyperliquid) don't support individual queries;
   * implementations will filter from the bulk endpoint.
   */
  fetchFundingRate(symbol: string): Promise<FundingRateData>

  /** Fetch funding rates for all contracts. Prefer this over fetchFundingRate to reduce request count. */
  fetchFundingRates(): Promise<FundingRateData[]>

  /**
   * Settlement period per symbol, in hours. Optional: only some venues expose
   * it (Binance does; Hyperliquid instead reports it on each funding rate).
   * Returns a symbol → hours map.
   */
  fetchFundingIntervals?(): Promise<Record<string, number>>

  /** Open interest for one contract. Optional — not every venue reports it. */
  fetchOpenInterest?(symbol: string): Promise<OpenInterestData>

  /**
   * Leverage brackets for one contract, ascending by notional cap: the max
   * leverage allowed at each position size. Optional — venues without a
   * bracket API fall back to market.limits.leverage.max via maxLeverageFor.
   */
  fetchLeverageTiers?(symbol: string): Promise<LeverageTier[]>

  // ── Account (perp-specific) ───────────────────────────────────────────────

  /**
   * Fetch position list.
   * @param symbols filter by contract list; returns all positions (including flat) if omitted
   */
  fetchPositions(symbols?: string[]): Promise<ExchangePosition[]>

  /** Fetch position details for a single contract */
  fetchPosition(symbol: string): Promise<ExchangePosition>

  /**
   * The ACCOUNT's current position mode — hedged (dual-side: long and short
   * are separate books) or one-way (netting: a single signed position).
   *
   * Distinct from `supportsPositionSide`, which only says the VENUE offers
   * hedge mode. An account on a hedge-capable venue may still be in one-way
   * mode, where sending positionSide is rejected and an opposite-side order
   * reduces the existing position instead of opening a new one.
   *
   * Optional: venues with no hedge mode at all omit it (callers treat that as
   * one-way).
   */
  fetchPositionMode?(symbol?: string): Promise<{ hedged: boolean }>

  /**
   * Adjust the client-side request throttle at runtime. `0` removes it.
   *
   * Whether a throttle helps is the CALLER's judgement, not a deployment
   * setting: a poller wants one, while a timed order ladder is harmed by it —
   * the throttle re-serialises orders that were deliberately spread across a
   * minute, so they reach the venue after the instant they were planned for.
   * The venue's own limits still apply; this only removes the local queue.
   *
   * Optional — adapters without a client throttle omit it.
   */
  setRateLimit?(ms: number): void

  // ── Trading (perp-specific) ───────────────────────────────────────────────

  /**
   * Place an order (perp version).
   * Supports reduceOnly (close-only) and timeInForce.
   */
  createOrder(params: PerpOrderParams): Promise<ExchangeOrder>

  /**
   * Set leverage multiplier.
   * @param params exchange-specific params, e.g. Hyperliquid's { isCross: true }
   */
  setLeverage(symbol: string, leverage: number, params?: Record<string, unknown>): Promise<void>

  /**
   * Switch margin mode.
   * cross = cross margin (shared account balance), isolated = isolated margin (dedicated margin per position)
   * @param params exchange-specific params, e.g. Hyperliquid requires { leverage }
   */
  setMarginMode(symbol: string, marginMode: 'cross' | 'isolated', params?: Record<string, unknown>): Promise<void>
}
