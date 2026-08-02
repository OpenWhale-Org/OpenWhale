import type { SpotExchangeAdapter } from '../types/spot.js'
import { OwAccount } from '@openwhaleorg/core'
import type { IAccountBalance, IOrder, IHistoryRecord } from '../types/account.js'
import type { Ticker, Kline, OrderBook, ExchangeBalance, ExchangeOrder, ExchangeTrade } from '../types/exchange.js'

/** Tokens valued 1:1 with USD when the venue doesn't provide valuations. */
const DEFAULT_STABLE_TOKENS = ['USDC', 'USDT', 'USD', 'DAI', 'USDF', 'FDUSD']

export interface SpotAccountOptions {
  /** Tokens treated as 1:1 USD for the aggregate view. Defaults to common stables. */
  stableTokens?: string[]
}

/**
 * Read-only view of a spot-venue credential — the 'exchange/spot' kind's
 * canonical Reader. Wraps the session privately and exposes no write methods;
 * order flow must travel instruction → queue → executor.
 *
 * Deliberately NOT a subset of PerpAccount: spot has no positions, no
 * leverage, no funding — holdings ARE the balances. The aggregate usd view
 * only prices stable tokens (a spot account holds arbitrary assets, and
 * inventing valuations without a price feed would be worse than omitting
 * them); the per-token breakdown always carries everything.
 */
@OwAccount({ id: 'spot-account', kind: 'exchange/spot', displayName: 'Spot Account (any venue)' })
export class SpotAccount {
  /** Serializable matching metadata — the framework compares strings, never instanceof. */
  static readonly kind = 'exchange/spot' as const
  static readonly venueType?: string

  private readonly stableTokens: Set<string>

  constructor(
    readonly name: string,
    protected readonly session: SpotExchangeAdapter,
    options?: SpotAccountOptions,
  ) {
    this.stableTokens = new Set(options?.stableTokens ?? DEFAULT_STABLE_TOKENS)
  }

  // ── Account reads ───────────────────────────────────────────────────────────

  async balance(): Promise<IAccountBalance> {
    const balances = await this.session.fetchBalance()
    const tokens = balances.map(b => ({
      token: b.currency,
      free: b.free,
      locked: b.used,
      total: b.total,
      ...(this.stableTokens.has(b.currency) ? { usdValue: b.total } : {}),
    }))
    const usd = tokens.reduce(
      (acc, t) => {
        if (t.usdValue === undefined) return acc
        const rate = t.total > 0 ? t.usdValue / t.total : 1
        return { available: acc.available + t.free * rate, total: acc.total + t.usdValue }
      },
      { available: 0, total: 0 },
    )
    return { usd, tokens }
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

  /**
   * Point-in-time equity sample for the runtime's account snapshotter.
   * Spot has no positions — equity is the priceable-token aggregate (only
   * stables are valued; non-stable holdings need a pricing source to count).
   */
  async snapshot(): Promise<{ equity: number; available?: number }> {
    const balance = await this.balance()
    return { equity: balance.usd.total, available: balance.usd.available }
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
  // Full-fidelity passthroughs of every read the adapter offers. Readers must
  // surface ALL read capabilities: generated strategies may not define their
  // own Readers, so anything missing here is unreachable for them.

  fetchBalance(): Promise<ExchangeBalance[]> { return this.session.fetchBalance() }
  fetchOpenOrders(symbol?: string): Promise<ExchangeOrder[]> { return this.session.fetchOpenOrders(symbol) }
  fetchOrders(symbol?: string, limit?: number): Promise<ExchangeOrder[]> { return this.session.fetchOrders(symbol, limit) }
  fetchOrder(orderId: string, symbol: string): Promise<ExchangeOrder> { return this.session.fetchOrder(orderId, symbol) }
  fetchMyTrades(symbol?: string, limit?: number): Promise<ExchangeTrade[]> { return this.session.fetchMyTrades(symbol, limit) }

  // ── Market data reads (public data of this credential's venue) ─────────────
  //
  // watch* streams are deliberately NOT exposed: strategies are trigger-driven;
  // continuous streams belong in Monitors.

  fetchTicker(symbol: string): Promise<Ticker> { return this.session.fetchTicker(symbol) }
  fetchOrderBook(symbol: string, depth?: number): Promise<OrderBook> { return this.session.fetchOrderBook(symbol, depth) }
  fetchOHLCV(symbol: string, timeframe: string, limit?: number): Promise<Kline[]> { return this.session.fetchOHLCV(symbol, timeframe, limit) }
  fetchTrades(symbol: string, limit?: number): Promise<ExchangeTrade[]> { return this.session.fetchTrades(symbol, limit) }
}
