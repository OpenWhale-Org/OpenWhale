import type { MarketInfo } from '@openwhaleorg/exchange'

/**
 * CrossEx symbols name the exchange they live on.
 *
 * `EXCHANGE_BUSINESS_BASE_QUOTE` — `BINANCE_SWAP_BTC_USDT` is Binance's BTC
 * perpetual, `GATE_SPOT_ETH_USDT` is Gate spot. One account holds all of them
 * against ONE shared margin pool, which is the whole point of CrossEx and the
 * reason it is modelled here as a single venue rather than one per exchange:
 * a model that showed Binance and OKX as separate venues would imply separate
 * collateral, and be wrong exactly when it matters — near liquidation.
 */

export interface CrossExSymbolParts {
  /** BINANCE | OKX | BYBIT | GATE | KRAKEN | HYPERLIQUID | DERIBIT … */
  exchange: string
  /** SWAP | SPOT | MARGIN … — the venue's product line, verbatim. */
  business: string
  base: string
  quote: string
}

/**
 * Split a CrossEx symbol, or return undefined when it is not one.
 *
 * Underscores separate the four parts, and only the four: a base asset that
 * itself contains an underscore would be ambiguous, so the tail is taken as
 * the quote and everything between business and quote as the base.
 */
export function parseCrossExSymbol(symbol: string): CrossExSymbolParts | undefined {
  const parts = symbol.split('_')
  if (parts.length < 4) return undefined
  const [exchange, business, ...rest] = parts as [string, string, ...string[]]
  const quote = rest[rest.length - 1]!
  const base = rest.slice(0, -1).join('_')
  if (!exchange || !business || !base || !quote) return undefined
  return { exchange, business, base, quote }
}

export function formatCrossExSymbol(parts: CrossExSymbolParts): string {
  return [parts.exchange, parts.business, parts.base, parts.quote].join('_')
}

/** ccxt-style symbol for the SAME market on its own exchange, for public data. */
export function underlyingSymbol(symbol: string): string | undefined {
  const parts = parseCrossExSymbol(symbol)
  if (!parts) return undefined
  const spot = `${parts.base}/${parts.quote}`
  return parts.business === 'SPOT' ? spot : `${spot}:${parts.quote}`
}

/** Which of our venue adapters serves this symbol's own exchange, if any. */
export function underlyingVenue(symbol: string): string | undefined {
  const exchange = parseCrossExSymbol(symbol)?.exchange
  return exchange ? exchange.toLowerCase() : undefined
}

/** Business line → the market type a picker groups by. */
function marketType(business: string): MarketInfo['type'] {
  switch (business.toUpperCase()) {
    case 'SPOT': return 'spot'
    case 'MARGIN': return 'spot'      // margin trades the spot book with borrowed funds
    case 'SWAP': return 'swap'
    case 'FUTURES': return 'future'
    case 'DELIVERY': return 'future'
    case 'OPTION': return 'option'
    default: return 'other'
  }
}

/** One `/crossex/rule/symbols` row, as the picker and the precision rules see it. */
export interface CrossExRule {
  symbol: string
  exchange_type: string
  business_type: string
  state: string
  min_size: string
  min_notional: string
  lot_size: string
  tick_size: string
  contract_size: string
  max_limit_size?: string
  max_market_size?: string
  max_num_orders?: string
  delist_time?: string
  support_rpi?: string
}

/**
 * A rule row as a MarketInfo.
 *
 * The exchange and product line are carried as tags rather than folded into
 * the symbol string a caller submits: the symbol IS the venue's identifier and
 * must travel unchanged, while a picker still needs to group 400 markets by
 * the exchange they sit on.
 */
export function ruleToMarket(rule: CrossExRule): MarketInfo {
  const parts = parseCrossExSymbol(rule.symbol)
  return {
    symbol: rule.symbol,
    base: parts?.base ?? rule.symbol,
    quote: parts?.quote ?? '',
    type: marketType(rule.business_type || parts?.business || ''),
    // Gate reports state as a word; anything other than an explicit online
    // state is treated as not tradable rather than guessed at.
    active: rule.state.toUpperCase() === 'ONLINE' || rule.state.toUpperCase() === 'TRADING',
    ...(parts?.quote ? { settle: parts.quote } : {}),
    tags: [rule.exchange_type, rule.business_type].filter(Boolean),
  }
}

/** Round `value` down to a multiple of `step`, without binary-float drift. */
export function roundToStep(value: number, step: number, mode: 'floor' | 'nearest' = 'floor'): number {
  if (!(step > 0)) return value
  const steps = value / step
  const rounded = mode === 'floor' ? Math.floor(steps + 1e-9) : Math.round(steps)
  // Re-round to the step's own decimals: 0.1 * 3 is 0.30000000000000004, and a
  // venue that parses the string rejects it as off-tick.
  const decimals = decimalsOf(step)
  return Number((rounded * step).toFixed(decimals))
}

function decimalsOf(step: number): number {
  const text = step.toExponential()
  const [mantissa, exponent] = text.split('e') as [string, string]
  const mantissaDecimals = (mantissa.split('.')[1] ?? '').length
  return Math.max(0, mantissaDecimals - Number(exponent))
}
