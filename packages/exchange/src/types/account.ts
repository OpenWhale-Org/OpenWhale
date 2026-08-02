
/** Balance of a single token, denominated in the token itself. */
export interface ITokenBalance {
  token: string       // 'USDC', 'ETH', ...
  free: number        // available (token units)
  locked: number      // locked in orders / margin (token units)
  total: number       // free + locked (token units)
  /** USD valuation; omitted when the platform cannot price this token. */
  usdValue?: number
}

/**
 * Composite account balance: a USD aggregate plus the per-token breakdown.
 * One call, one snapshot — the aggregate is always consistent with the tokens.
 */
export interface IAccountBalance {
  /** Aggregate account value in USD (sum of priceable token valuations). */
  usd: {
    available: number
    total: number
  }
  /** Per-token breakdown; single-collateral platforms return one entry. */
  tokens: ITokenBalance[]
}

export interface IPosition {
  id: string
  /** Position direction. Strategies use this to compute signed exposure. */
  side: 'long' | 'short'
  value: number       // Current market value (USD-denominated, always positive)
  pnl: number         // Unrealized PnL (USD-denominated)
}

export interface IOrder {
  id: string
  side: 'buy' | 'sell'
  value: number       // Order value (USD-denominated)
  status: 'open' | 'partial'
}

/** PnL figures are USD-denominated by convention. */
export interface IPnL {
  realized: number
  unrealized: number
}

export interface IHistoryRecord {
  id: string
  timestamp: number
  type: string        // 'trade' | 'transfer' | 'funding' | ...
  value: number       // USD-denominated
}


