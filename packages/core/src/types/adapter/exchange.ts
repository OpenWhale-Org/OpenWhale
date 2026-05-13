/**
 * Shared data types for exchange adapters.
 *
 * Field names align with ccxt to minimize mapping overhead in implementations.
 * All prices/amounts are number (float); currency unit is identified by the symbol or currency field.
 */

/** Ticker snapshot */
export interface Ticker {
  symbol: string
  timestamp: number
  last: number          // last trade price
  bid: number           // best bid price
  ask: number           // best ask price
  high: number          // 24h high
  low: number           // 24h low
  volume: number        // 24h volume (base asset)
  quoteVolume: number   // 24h volume (quote asset)
}

/** OHLCV candlestick */
export interface Kline {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Order book snapshot.
 * bids/asks are price-sorted: bids descending (best bid first), asks ascending (best ask first).
 */
export interface OrderBook {
  symbol: string
  timestamp: number
  bids: [number, number][]  // [price, amount][]
  asks: [number, number][]
}

/** Account balance for a single currency */
export interface ExchangeBalance {
  currency: string
  free: number    // available balance
  used: number    // locked (open order margin / position margin)
  total: number   // free + used
}

/**
 * Perpetual futures position.
 * notional = contracts × contractSize × markPrice (USD-denominated)
 */
export interface ExchangePosition {
  symbol: string
  side: 'long' | 'short'
  contracts: number         // number of contracts held
  contractSize: number      // face value per contract
  entryPrice: number        // average entry price
  markPrice: number         // current mark price
  notional: number          // notional value (USD)
  unrealizedPnl: number     // unrealized PnL (USD)
  leverage: number          // current leverage
  liquidationPrice: number  // liquidation price
  marginMode: 'cross' | 'isolated'
  initialMargin: number     // initial margin
  maintenanceMargin: number // maintenance margin
}

/** Order */
export interface ExchangeOrder {
  id: string
  symbol: string
  type: 'market' | 'limit'
  side: 'buy' | 'sell'
  price: number
  amount: number    // order quantity (base asset)
  filled: number    // filled quantity
  remaining: number // unfilled quantity
  status: 'open' | 'closed' | 'canceled' | 'rejected' | 'expired'
  timestamp: number
  reduceOnly: boolean
  timeInForce: 'GTC' | 'IOC' | 'FOK' | 'PO'
  fee?: { cost: number; currency: string }
}

/** Single trade record */
export interface ExchangeTrade {
  id: string
  symbol: string
  side: 'buy' | 'sell'
  price: number
  amount: number
  cost: number      // price × amount (trade value)
  timestamp: number
  fee?: { cost: number; currency: string }
  takerOrMaker: 'taker' | 'maker'
}

/** Funding rate data */
export interface FundingRateData {
  symbol: string
  fundingRate: number           // current funding rate (decimal, e.g. 0.0001 = 0.01%)
  fundingTimestamp: number      // current settlement timestamp (ms)
  nextFundingTimestamp: number  // next settlement timestamp (ms)
}

/** Spot order parameters */
export interface SpotOrderParams {
  symbol: string
  side: 'buy' | 'sell'
  type: 'market' | 'limit'
  amount: number
  price?: number          // required for limit orders
  clientOrderId?: string  // client-defined order ID for idempotency
  /** Exchange-specific passthrough params, does not affect the generic interface semantics */
  params?: Record<string, unknown>
}

/** Perpetual futures order parameters (extends spot params) */
export interface PerpOrderParams extends SpotOrderParams {
  /** Reduce-only: close existing position without opening a new one */
  reduceOnly?: boolean
  /** Order validity type: GTC=good till cancel / IOC=immediate or cancel / FOK=fill or kill / PO=post-only */
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PO'
}
