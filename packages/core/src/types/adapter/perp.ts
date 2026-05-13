import type { ExchangePosition, ExchangeOrder, FundingRateData, PerpOrderParams } from './exchange.js'
import type { SpotExchangeAdapter } from './spot.js'

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
  // ── Market data (perp-specific) ───────────────────────────────────────────

  /**
   * Fetch the current funding rate for a single contract.
   * Note: some exchanges (e.g. Hyperliquid) don't support individual queries;
   * implementations will filter from the bulk endpoint.
   */
  fetchFundingRate(symbol: string): Promise<FundingRateData>

  /** Fetch funding rates for all contracts. Prefer this over fetchFundingRate to reduce request count. */
  fetchFundingRates(): Promise<FundingRateData[]>

  // ── Account (perp-specific) ───────────────────────────────────────────────

  /**
   * Fetch position list.
   * @param symbols filter by contract list; returns all positions (including flat) if omitted
   */
  fetchPositions(symbols?: string[]): Promise<ExchangePosition[]>

  /** Fetch position details for a single contract */
  fetchPosition(symbol: string): Promise<ExchangePosition>

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
   */
  setMarginMode(symbol: string, marginMode: 'cross' | 'isolated'): Promise<void>
}
