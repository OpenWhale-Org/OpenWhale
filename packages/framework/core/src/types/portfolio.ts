export type PortfolioMode = 'paper' | 'live'
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
