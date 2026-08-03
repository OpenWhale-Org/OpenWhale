import type { PerpExchangeAdapter } from '../types/perp.js'
import { OwAccount } from '@openwhaleorg/core'
import type { IAccountBalance, IPosition, IOrder, IPnL, IHistoryRecord } from '../types/account.js'
import type { Ticker, Kline, OrderBook, FundingRateData, ExchangeBalance, ExchangePosition, ExchangeOrder, ExchangeTrade } from '../types/exchange.js'

/** Tokens valued 1:1 with USD when the venue doesn't provide valuations. */
const DEFAULT_STABLE_TOKENS = ['USDC', 'USDT', 'USD', 'DAI', 'USDF', 'FDUSD']

export interface PerpAccountOptions {
  /** Tokens treated as 1:1 USD for the aggregate view. Defaults to common stables. */
  stableTokens?: string[]
}

/**
 * Read-only view of a perp-venue credential — the 'exchange/perp' kind's
 * canonical Reader. This is the ONLY venue object a strategy can hold: it
 * wraps the session privately and exposes no write methods. Order flow must
 * travel instruction → queue → executor.
 *
 * Strategies declare it by class reference:
 *
 *   accounts: [{ account: PerpAccount, label: 'main' }]        // any perp venue
 *
 * Venue subclasses (registered via CredentialTypeDefinition.readers) may add
 * typed venue-specific read methods and pin the venue via `static venueType`.
 */
@OwAccount({ id: 'perp-account', kind: 'exchange/perp', displayName: 'Perp Account (any venue)' })
export class PerpAccount {
  /** Serializable matching metadata — the framework compares strings, never instanceof. */
  static readonly kind = 'exchange/perp' as const
  static readonly venueType?: string

  private readonly stableTokens: Set<string>

  constructor(
    readonly name: string,
    protected readonly session: PerpExchangeAdapter,
    options?: PerpAccountOptions,
  ) {
    this.stableTokens = new Set(options?.stableTokens ?? DEFAULT_STABLE_TOKENS)
  }

  // ── Account reads ───────────────────────────────────────────────────────────

  async balance(): Promise<IAccountBalance> {
    // Unified/portfolio-margin accounts first: their wallet rows LIE (the
    // settlement currency can be a negative loan while collateral sits in
    // other assets) — the venue's adjusted equity is the only honest number.
    const pm = await this.session.fetchPortfolioEquity?.().catch(() => null)
    const balances = await this.session.fetchBalance()
    const tokens = balances.map(b => ({
      token: b.currency,
      free: b.free,
      locked: b.used,
      total: b.total,
      ...(this.stableTokens.has(b.currency) ? { usdValue: b.total } : {}),
    }))
    // Aggregate = sum of priceable tokens (perp collateral is normally a stable)
    const usd = pm
      ? { available: pm.availableUsd, total: pm.equityUsd }
      : tokens.reduce(
        (acc, t) => {
          if (t.usdValue === undefined) return acc
          const rate = t.total > 0 ? t.usdValue / t.total : 1
          return { available: acc.available + t.free * rate, total: acc.total + t.usdValue }
        },
        { available: 0, total: 0 },
      )
    return { usd, tokens }
  }

  async positions(): Promise<IPosition[]> {
    const positions = await this.session.fetchPositions()
    return positions
      .filter(p => p.contracts !== 0)
      .map(p => ({
        id: p.symbol,
        side: p.side,
        value: p.notional,
        pnl: p.unrealizedPnl,
      }))
  }

  /**
   * Point-in-time equity sample — the runtime's account snapshotter calls
   * this to feed the dashboard's equity curve. Equity = priceable collateral
   * + unrealized PnL across open positions (the usual perp account-value
   * convention; venues that already bake unrealized PnL into balances may
   * double-count slightly — venue readers can override).
   */
  async snapshot(): Promise<{ equity: number; available?: number; unrealizedPnl?: number }> {
    // Portfolio-margin equity already INCLUDES unrealized PnL — adding it
    // again double-counts (and the wallet-sum path read a healthy unified account
    // as −$2.2k equity live).
    const pm = await this.session.fetchPortfolioEquity?.().catch(() => null)
    if (pm) {
      const positions = await this.session.fetchPositions()
      const unrealized = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
      return { equity: pm.equityUsd, available: pm.availableUsd, unrealizedPnl: unrealized }
    }
    const [balance, positions] = await Promise.all([this.balance(), this.session.fetchPositions()])
    const unrealized = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
    return { equity: balance.usd.total + unrealized, available: balance.usd.available, unrealizedPnl: unrealized }
  }

  async orders(): Promise<IOrder[]> {
    const orders = await this.session.fetchOpenOrders()
    return orders.map(o => ({
      id: o.id,
      side: o.side,
      value: o.amount * (o.average ?? o.price),
      status: o.filled > 0 ? 'partial' as const : 'open' as const,
    }))
  }

  async pnl(_since?: Date): Promise<IPnL> {
    const positions = await this.session.fetchPositions()
    const unrealized = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)
    // Realized PnL is not uniformly available across venues via ccxt order
    // objects — report 0 rather than a fabricated number. Venue reader
    // overrides may provide a real figure.
    return { realized: 0, unrealized }
  }

  async history(limit = 50): Promise<IHistoryRecord[]> {
    const orders = await this.session.fetchOrders(undefined, limit)
    return orders
      .filter(o => o.status === 'closed')
      .map(o => ({
        id: o.id,
        timestamp: o.timestamp,
        type: 'trade',
        value: o.filled * (o.average ?? o.price),
      }))
  }

  // ── Raw-shape reads ─────────────────────────────────────────────────────────
  //
  // The aggregate views above trade detail for uniformity (IPosition has no
  // entryPrice/leverage, IOrder no price/amount). These passthroughs expose
  // every read the adapter offers in full fidelity. Readers must surface ALL
  // read capabilities: generated strategies may not define their own Readers,
  // so anything missing here is unreachable for them.

  fetchBalance(): Promise<ExchangeBalance[]> { return this.session.fetchBalance() }
  fetchPositions(symbols?: string[]): Promise<ExchangePosition[]> { return this.session.fetchPositions(symbols) }
  fetchPosition(symbol: string): Promise<ExchangePosition> { return this.session.fetchPosition(symbol) }
  fetchOpenOrders(symbol?: string): Promise<ExchangeOrder[]> { return this.session.fetchOpenOrders(symbol) }
  fetchOrders(symbol?: string, limit?: number): Promise<ExchangeOrder[]> { return this.session.fetchOrders(symbol, limit) }
  fetchOrder(orderId: string, symbol: string): Promise<ExchangeOrder> { return this.session.fetchOrder(orderId, symbol) }
  fetchMyTrades(symbol?: string, limit?: number): Promise<ExchangeTrade[]> { return this.session.fetchMyTrades(symbol, limit) }

  // ── Market data reads (public data of this credential's venue) ─────────────
  //
  // watch* streams are deliberately NOT exposed: strategies are trigger-driven
  // and must not block on streams inside evaluate() — continuous streams
  // belong in Monitors.

  fetchTicker(symbol: string): Promise<Ticker> { return this.session.fetchTicker(symbol) }
  fetchOrderBook(symbol: string, depth?: number): Promise<OrderBook> { return this.session.fetchOrderBook(symbol, depth) }
  fetchOHLCV(symbol: string, timeframe: string, limit?: number): Promise<Kline[]> { return this.session.fetchOHLCV(symbol, timeframe, limit) }
  fetchTrades(symbol: string, limit?: number): Promise<ExchangeTrade[]> { return this.session.fetchTrades(symbol, limit) }
  fetchFundingRate(symbol: string): Promise<FundingRateData> { return this.session.fetchFundingRate(symbol) }
  fetchFundingRates(): Promise<FundingRateData[]> { return this.session.fetchFundingRates() }

  /**
   * Leverage brackets ascending by notional cap; the max leverage a NOTIONAL
   * may use = the first bracket whose cap covers it. Venues without the
   * optional adapter method report one Infinity-cap bracket at 1x — callers
   * should treat that as "unknown, stay conservative".
   */
  async fetchLeverageTiers(symbol: string): Promise<Array<{ maxNotionalUsd: number; maxLeverage: number }>> {
    if (!this.session.fetchLeverageTiers) return [{ maxNotionalUsd: Infinity, maxLeverage: 1 }]
    return this.session.fetchLeverageTiers(symbol)
  }

  /**
   * The venue's market catalogue, with classification tags where the venue
   * publishes them (Binance underlyingSubType → tags). Empty when the adapter
   * has no catalogue — callers treat that as "no metadata", not an error.
   */
  async markets(): Promise<import('../types/exchange.js').MarketInfo[]> {
    return this.session.fetchMarkets ? this.session.fetchMarkets() : []
  }

  /** Max leverage allowed for a USD notional, from the venue's brackets. */
  async maxLeverageFor(symbol: string, notionalUsd: number): Promise<number> {
    const tiers = await this.fetchLeverageTiers(symbol)
    const tier = tiers.find(t => notionalUsd <= t.maxNotionalUsd) ?? tiers[tiers.length - 1]
    return tier?.maxLeverage ?? 1
  }
}
