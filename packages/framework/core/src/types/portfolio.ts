/**
 * 这本台账服务的是**交易所不知道的那些交易**。
 *
 * 实盘不走这里。实盘的成交、资费、归属已经有一整条路：执行器下单时认领订单号
 * （pnl_order_claims），采集器从交易所把真实成交和资费拉回来（pnl_fills /
 * pnl_funding），再顺着认领归属到实例；执行记录里另有每一片的计划与实际。
 * 那条路的依据是**交易所的事实**。
 *
 * 模拟盘没有那个事实可依 —— 交易所根本不知道这些单存在 —— 所以只能由策略
 * 自述，也就必须另有去处。这就是这本台账存在的全部理由。
 *
 * 两者不能混：同一笔实盘交易若两边都记，就有了两份互相矛盾的账，而且自述的
 * 那份没有订单号，对不了账。所以这里**没有 'live'** —— 不是忘了写，是不允许。
 * 将来可以加 'backtest'，它同样属于「交易所不知道」的那一类。
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
