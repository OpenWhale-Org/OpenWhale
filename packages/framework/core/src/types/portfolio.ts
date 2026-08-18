/**
 * This journal accounts for trades the venue does not know about.
 *
 * Live trading does not come here. It already has a path whose evidence is the
 * venue itself: executors claim the order ids they place (pnl_order_claims), a
 * collector pulls the real fills and funding back (pnl_fills / pnl_funding) and
 * attributes them to an instance through those claims, and the execution
 * records hold every slice's plan against what actually happened.
 *
 * A simulation has no such evidence — the venue has no idea those orders exist
 * — so the strategy's own account is all there is, and it needs somewhere else
 * to live. That is the entire reason this journal exists.
 *
 * The two must not mix. Recording one real trade on both sides produces two
 * ledgers that disagree, and the self-reported one carries no order id, so
 * nothing can reconcile it. Hence there is no 'live' here — not an omission,
 * a prohibition. A future 'backtest' would belong, for the same reason paper
 * does: the venue does not know about it either.
 */
export type PortfolioMode = 'paper'
export type PortfolioFillIntent = 'open' | 'reduce' | 'close'

export interface PortfolioPositionSnapshot {
  id: string
  symbol: string
  side: 'long' | 'short'
  quantity: number
  entryPrice: number
  markPrice: number
  notionalUsd: number
  unrealizedPnlUsd: number
  openedAt: number
  leverage?: number
  stopPrice?: number
  takeProfitPrice?: number
}

export interface PortfolioSnapshot {
  mode: PortfolioMode
  timestamp: number
  startingEquityUsd: number
  equityUsd: number
  availableUsd: number
  usedMarginUsd: number
  realizedPnlUsd: number
  unrealizedPnlUsd: number
  feesUsd: number
  netPnlUsd: number
  returnPct: number
  positions: PortfolioPositionSnapshot[]
}

export interface PortfolioFillEvent {
  id: string
  planId: string
  timestamp: number
  symbol: string
  side: 'buy' | 'sell'
  intent: PortfolioFillIntent
  quantity: number
  price: number
  notionalUsd: number
  feeUsd: number
  realizedPnlUsd: number
  reason?: string
}

export interface PortfolioDecisionEvent {
  id: string
  timestamp: number
  symbol: string
  action: string
  confidence?: number
  reason?: string
  metadata?: Record<string, unknown>
}

export interface PortfolioMarketBar {
  symbol: string
  timestamp: number
  open: number
  high: number
  low: number
  close: number
}

export interface PortfolioUpdate {
  commitId: string
  snapshot: PortfolioSnapshot
  fills?: PortfolioFillEvent[]
  decisions?: PortfolioDecisionEvent[]
  marketBars?: PortfolioMarketBar[]
}

export interface PortfolioReportQuery {
  from?: number
  to?: number
  symbol?: string
  limit?: number
}

export interface PortfolioEquityPoint {
  timestamp: number
  equityUsd: number
  netPnlUsd: number
  realizedPnlUsd: number
  unrealizedPnlUsd: number
  drawdownPct: number
}

export interface PortfolioTrade {
  planId: string
  symbol: string
  side: 'long' | 'short'
  status: 'open' | 'closed'
  openedAt: number
  closedAt?: number
  entryPrice: number
  exitPrice?: number
  openedQuantity: number
  remainingQuantity: number
  realizedPnlUsd: number
  feesUsd: number
  netPnlUsd: number
  exitReason?: string
}

export interface PortfolioReportSummary extends PortfolioSnapshot {
  maxDrawdownPct: number
  closedTrades: number
  winningTrades: number
  losingTrades: number
  winRatePct: number
  profitFactor: number | null
}

export interface PortfolioReport {
  summary: PortfolioReportSummary
  equity: PortfolioEquityPoint[]
  fills: PortfolioFillEvent[]
  trades: PortfolioTrade[]
  decisions: PortfolioDecisionEvent[]
  marketBars: PortfolioMarketBar[]
}

export interface IPortfolioJournal {
  commit(update: PortfolioUpdate): Promise<void>
  report(query?: PortfolioReportQuery): Promise<PortfolioReport | undefined>
}
