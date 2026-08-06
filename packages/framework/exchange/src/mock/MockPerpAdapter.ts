import type { PerpExchangeAdapter } from '../types/perp.js'
import type {
  Ticker, Kline, OrderBook, MarketInfo,
  ExchangeBalance, ExchangeOrder, ExchangeTrade, ExchangePosition,
  FundingRateData, PerpOrderParams,
} from '../types/exchange.js'

/**
 * In-memory PerpExchangeAdapter with canned data and side-effect-free writes.
 *
 * Registered as kind 'exchange/perp''s createMockSession: the AI compiler's
 * dry-run wraps it in the real PerpAccount so generated strategies run against
 * genuine Reader code over fake data. Also usable in tests and paper runs.
 */
export class MockPerpAdapter implements PerpExchangeAdapter {
  private orderSeq = 0

  private ticker(symbol: string): Ticker {
    return { symbol, last: 50_000, bid: 49_995, ask: 50_005, high: 51_000, low: 49_000, volume: 1_000, quoteVolume: 50_000_000, timestamp: 1 }
  }

  async fetchTicker(symbol: string): Promise<Ticker> { return this.ticker(symbol) }

  async fetchOrderBook(symbol: string, depth = 5): Promise<OrderBook> {
    const levels = (base: number, dir: 1 | -1) =>
      Array.from({ length: depth }, (_, i) => [base + dir * i * 5, 1 + i] as [number, number])
    return { symbol, bids: levels(49_995, -1), asks: levels(50_005, 1), timestamp: 1 }
  }

  async fetchOHLCV(symbol: string, _timeframe: string, limit = 100, _since?: number): Promise<Kline[]> {
    return Array.from({ length: Math.min(limit, 100) }, (_, i) => ({
      timestamp: i * 60_000, open: 50_000, high: 50_100, low: 49_900, close: 50_050, volume: 10,
    }))
  }

  async fetchMarkets(): Promise<MarketInfo[]> {
    return [
      { symbol: 'BTC/USDC:USDC', base: 'BTC', quote: 'USDC', type: 'swap', active: true, settle: 'USDC' },
      { symbol: 'ETH/USDC:USDC', base: 'ETH', quote: 'USDC', type: 'swap', active: true, settle: 'USDC' },
      { symbol: 'SOL/USDC:USDC', base: 'SOL', quote: 'USDC', type: 'swap', active: true, settle: 'USDC' },
    ]
  }

  async fetchTrades(symbol: string, limit = 20): Promise<ExchangeTrade[]> {
    return Array.from({ length: Math.min(limit, 20) }, (_, i) => ({
      id: `pub-${i}`, symbol, side: i % 2 ? 'sell' as const : 'buy' as const,
      price: 50_000, amount: 0.1, cost: 5_000, timestamp: i * 1_000, takerOrMaker: 'taker' as const,
    }))
  }

  async fetchBalance(): Promise<ExchangeBalance[]> {
    return [{ currency: 'USDC', free: 8_000, used: 2_000, total: 10_000 }]
  }

  async fetchPositions(symbols?: string[]): Promise<ExchangePosition[]> {
    const all: ExchangePosition[] = [{
      symbol: 'BTC/USDC:USDC', side: 'long', contracts: 0.1, contractSize: 1,
      entryPrice: 48_000, markPrice: 50_000, notional: 5_000, leverage: 5,
      unrealizedPnl: 200, liquidationPrice: 40_000, marginMode: 'cross',
      initialMargin: 1_000, maintenanceMargin: 250,
    }]
    return symbols ? all.filter(p => symbols.includes(p.symbol)) : all
  }

  async fetchPosition(symbol: string): Promise<ExchangePosition> {
    const positions = await this.fetchPositions([symbol])
    if (!positions[0]) throw new Error(`No position for ${symbol}`)
    return positions[0]
  }

  private order(symbol: string, overrides?: Partial<ExchangeOrder>): ExchangeOrder {
    return {
      id: `mock-${++this.orderSeq}`, symbol, type: 'limit', side: 'buy',
      price: 50_000, amount: 0.1, filled: 0.1, remaining: 0, average: 50_000,
      status: 'closed', timestamp: 1, reduceOnly: false, timeInForce: 'GTC', ...overrides,
    }
  }

  async fetchOpenOrders(symbol = 'BTC/USDC:USDC'): Promise<ExchangeOrder[]> {
    return [this.order(symbol, { status: 'open', filled: 0, remaining: 0.1 })]
  }

  async fetchOrders(symbol = 'BTC/USDC:USDC', limit = 10): Promise<ExchangeOrder[]> {
    return Array.from({ length: Math.min(limit, 10) }, () => this.order(symbol))
  }

  async fetchOrder(orderId: string, symbol: string): Promise<ExchangeOrder> {
    return this.order(symbol, { id: orderId })
  }

  async fetchMyTrades(symbol = 'BTC/USDC:USDC', limit = 10): Promise<ExchangeTrade[]> {
    return Array.from({ length: Math.min(limit, 10) }, (_, i) => ({
      id: `fill-${i}`, symbol, side: 'buy' as const, price: 50_000, amount: 0.1,
      cost: 5_000, timestamp: i * 1_000, takerOrMaker: 'taker' as const,
    }))
  }

  async fetchFundingRate(symbol: string): Promise<FundingRateData> {
    return { symbol, fundingRate: 0.0001, fundingTimestamp: 1, nextFundingTimestamp: 3_600_000 }
  }

  async fetchFundingRates(): Promise<FundingRateData[]> {
    return [await this.fetchFundingRate('BTC/USDC:USDC')]
  }

  // ── Writes: side-effect-free, return plausible results ──────────────────────

  async createOrder(params: PerpOrderParams): Promise<ExchangeOrder> {
    return this.order(params.symbol, {
      type: params.type, side: params.side,
      price: params.price ?? 50_000, amount: params.amount,
      filled: params.amount, remaining: 0,
    })
  }

  async cancelOrder(_orderId: string, _symbol: string): Promise<void> {}
  async cancelAllOrders(_symbol?: string): Promise<void> {}
  async setLeverage(_symbol: string, _leverage: number): Promise<void> {}
  async setMarginMode(_symbol: string, _marginMode: 'cross' | 'isolated'): Promise<void> {}
  async amountToPrecision(_symbol: string, amount: number): Promise<number> { return amount }
  async baseAmountToContracts(_symbol: string, baseAmount: number): Promise<number> { return baseAmount }

  // ── Streams: resolve immediately (nothing to stream) ────────────────────────

  async watchTicker(): Promise<void> {}
  async watchTrades(): Promise<void> {}
  async watchOrderBook(): Promise<void> {}
  async watchMyTrades(): Promise<void> {}
  async watchOrders(): Promise<void> {}

  async close(): Promise<void> {}
}
