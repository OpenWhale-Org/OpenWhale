import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import type {
  IPortfolioJournal,
  PortfolioDecisionEvent,
  PortfolioEquityPoint,
  PortfolioFillEvent,
  PortfolioMarketBar,
  PortfolioPositionSnapshot,
  PortfolioReport,
  PortfolioReportQuery,
  PortfolioSnapshot,
  PortfolioTrade,
  PortfolioUpdate,
} from '../types/portfolio.js'

interface SnapshotRow {
  [key: string]: unknown
  ts: number
  mode: 'paper' | 'live'
  starting_equity: number
  equity: number
  available: number
  used_margin: number
  realized_pnl: number
  unrealized_pnl: number
  fees: number
  net_pnl: number
  return_pct: number
  positions: string
}

interface FillRow {
  [key: string]: unknown
  fill_id: string
  plan_id: string
  ts: number
  symbol: string
  side: 'buy' | 'sell'
  intent: PortfolioFillEvent['intent']
  quantity: number
  price: number
  notional: number
  fee: number
  realized_pnl: number
  reason: string | null
}

interface DecisionRow {
  [key: string]: unknown
  decision_id: string
  ts: number
  symbol: string
  action: string
  confidence: number | null
  reason: string | null
  metadata: string | null
}

interface MarketBarRow {
  [key: string]: unknown
  symbol: string
  ts: number
  open: number
  high: number
  low: number
  close: number
}

const EPSILON = 1e-9

function downsample<T>(rows: T[], limit: number): T[] {
  if (rows.length <= limit) return rows
  if (limit === 1) return [rows.at(-1)!]
  const sampled: T[] = []
  const last = rows.length - 1
  for (let index = 0; index < limit; index += 1) {
    sampled.push(rows[Math.round(index * last / (limit - 1))]!)
  }
  return sampled
}

function snapshotFromRow(row: SnapshotRow): PortfolioSnapshot {
  let positions: PortfolioPositionSnapshot[] = []
  try { positions = JSON.parse(row.positions) as PortfolioPositionSnapshot[] } catch { /* corrupted projection stays empty */ }
  return {
    mode: row.mode,
    timestamp: row.ts,
    startingEquityUsd: row.starting_equity,
    equityUsd: row.equity,
    availableUsd: row.available,
    usedMarginUsd: row.used_margin,
    realizedPnlUsd: row.realized_pnl,
    unrealizedPnlUsd: row.unrealized_pnl,
    feesUsd: row.fees,
    netPnlUsd: row.net_pnl,
    returnPct: row.return_pct,
    positions,
  }
}

function fillFromRow(row: FillRow): PortfolioFillEvent {
  return {
    id: row.fill_id,
    planId: row.plan_id,
    timestamp: row.ts,
    symbol: row.symbol,
    side: row.side,
    intent: row.intent,
    quantity: row.quantity,
    price: row.price,
    notionalUsd: row.notional,
    feeUsd: row.fee,
    realizedPnlUsd: row.realized_pnl,
    ...(row.reason ? { reason: row.reason } : {}),
  }
}

function decisionFromRow(row: DecisionRow): PortfolioDecisionEvent {
  let metadata: Record<string, unknown> | undefined
  try { metadata = row.metadata ? JSON.parse(row.metadata) as Record<string, unknown> : undefined } catch { /* omit malformed metadata */ }
  return {
    id: row.decision_id,
    timestamp: row.ts,
    symbol: row.symbol,
    action: row.action,
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

function aggregateTrades(fills: PortfolioFillEvent[]): PortfolioTrade[] {
  const grouped = new Map<string, PortfolioFillEvent[]>()
  for (const fill of fills) grouped.set(fill.planId, [...(grouped.get(fill.planId) ?? []), fill])
  return [...grouped.entries()].flatMap(([planId, rows]) => {
    const ordered = rows.sort((a, b) => a.timestamp - b.timestamp)
    const entries = ordered.filter(fill => fill.intent === 'open')
    if (entries.length === 0) return []
    const exits = ordered.filter(fill => fill.intent !== 'open')
    const openedQuantity = entries.reduce((sum, fill) => sum + fill.quantity, 0)
    const exitedQuantity = exits.reduce((sum, fill) => sum + fill.quantity, 0)
    const weighted = (items: PortfolioFillEvent[]) => {
      const quantity = items.reduce((sum, fill) => sum + fill.quantity, 0)
      return quantity > EPSILON ? items.reduce((sum, fill) => sum + fill.price * fill.quantity, 0) / quantity : undefined
    }
    const entryPrice = weighted(entries)
    if (entryPrice === undefined) return []
    const remainingQuantity = Math.max(0, openedQuantity - exitedQuantity)
    const realizedPnlUsd = exits.reduce((sum, fill) => sum + fill.realizedPnlUsd, 0)
    const feesUsd = ordered.reduce((sum, fill) => sum + fill.feeUsd, 0)
    const lastExit = exits.at(-1)
    const exitPrice = weighted(exits)
    const side: PortfolioTrade['side'] = entries[0]!.side === 'buy' ? 'long' : 'short'
    const status: PortfolioTrade['status'] = remainingQuantity <= EPSILON ? 'closed' : 'open'
    return [{
      planId,
      symbol: entries[0]!.symbol,
      side,
      status,
      openedAt: entries[0]!.timestamp,
      ...(remainingQuantity <= EPSILON && lastExit ? { closedAt: lastExit.timestamp } : {}),
      entryPrice,
      ...(exitPrice !== undefined ? { exitPrice } : {}),
      openedQuantity,
      remainingQuantity,
      realizedPnlUsd,
      feesUsd,
      netPnlUsd: realizedPnlUsd - feesUsd,
      ...(lastExit?.reason || lastExit?.intent ? { exitReason: lastExit.reason ?? lastExit.intent } : {}),
    }]
  }).sort((a, b) => b.openedAt - a.openedAt)
}

export class PortfolioJournal implements IPortfolioJournal {
  constructor(
    private readonly instanceId: string,
    private readonly db: DatabaseAdapter,
  ) {}

  async commit(update: PortfolioUpdate): Promise<void> {
    await this.db.transaction(async () => {
      const inserted = await this.db.run(
        `INSERT OR IGNORE INTO portfolio_commits (instance_id, commit_id, ts) VALUES (?, ?, ?)`,
        [this.instanceId, update.commitId, update.snapshot.timestamp],
      )
      if (inserted === 0) return
      const snapshot = update.snapshot
      await this.db.run(
        `INSERT OR REPLACE INTO portfolio_snapshots
          (instance_id, ts, mode, starting_equity, equity, available, used_margin,
           realized_pnl, unrealized_pnl, fees, net_pnl, return_pct, positions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [this.instanceId, snapshot.timestamp, snapshot.mode, snapshot.startingEquityUsd,
          snapshot.equityUsd, snapshot.availableUsd, snapshot.usedMarginUsd,
          snapshot.realizedPnlUsd, snapshot.unrealizedPnlUsd, snapshot.feesUsd,
          snapshot.netPnlUsd, snapshot.returnPct, JSON.stringify(snapshot.positions)],
      )
      for (const fill of update.fills ?? []) {
        await this.db.run(
          `INSERT OR IGNORE INTO portfolio_fills
            (instance_id, fill_id, plan_id, ts, symbol, side, intent, quantity, price,
             notional, fee, realized_pnl, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [this.instanceId, fill.id, fill.planId, fill.timestamp, fill.symbol, fill.side,
            fill.intent, fill.quantity, fill.price, fill.notionalUsd, fill.feeUsd,
            fill.realizedPnlUsd, fill.reason ?? null],
        )
      }
      for (const decision of update.decisions ?? []) {
        await this.db.run(
          `INSERT OR IGNORE INTO portfolio_decisions
            (instance_id, decision_id, ts, symbol, action, confidence, reason, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [this.instanceId, decision.id, decision.timestamp, decision.symbol, decision.action,
            decision.confidence ?? null, decision.reason ?? null,
            decision.metadata ? JSON.stringify(decision.metadata) : null],
        )
      }
      for (const bar of update.marketBars ?? []) {
        await this.db.run(
          `INSERT OR REPLACE INTO portfolio_market_bars
            (instance_id, symbol, ts, open, high, low, close) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [this.instanceId, bar.symbol, bar.timestamp, bar.open, bar.high, bar.low, bar.close],
        )
      }
    })
  }

  async report(query: PortfolioReportQuery = {}): Promise<PortfolioReport | undefined> {
    const from = Math.max(0, query.from ?? 0)
    const to = Math.max(from, query.to ?? Date.now())
    const limit = Math.min(5_000, Math.max(1, query.limit ?? 1_000))
    const latest = await this.db.get<SnapshotRow>(
      `SELECT * FROM portfolio_snapshots WHERE instance_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`,
      [this.instanceId, to],
    )
    if (!latest) return undefined

    const snapshotRows = await this.db.all<SnapshotRow>(
      `SELECT * FROM portfolio_snapshots WHERE instance_id = ? AND ts <= ? ORDER BY ts ASC`,
      [this.instanceId, to],
    )
    let peak = 0
    let maxDrawdownPct = 0
    const equityRows: PortfolioEquityPoint[] = []
    for (const row of snapshotRows) {
      peak = Math.max(peak, row.equity)
      const drawdownPct = peak > 0 ? (row.equity - peak) / peak * 100 : 0
      if (row.ts >= from) {
        maxDrawdownPct = Math.min(maxDrawdownPct, drawdownPct)
        equityRows.push({
          timestamp: row.ts,
          equityUsd: row.equity,
          netPnlUsd: row.net_pnl,
          realizedPnlUsd: row.realized_pnl,
          unrealizedPnlUsd: row.unrealized_pnl,
          drawdownPct,
        })
      }
    }
    const equity = downsample(equityRows, limit)

    const symbolClause = query.symbol ? ' AND symbol = ?' : ''
    const rangeParams = query.symbol
      ? [this.instanceId, from, to, query.symbol]
      : [this.instanceId, from, to]
    const fillRows = await this.db.all<FillRow>(
      `SELECT * FROM (
         SELECT * FROM portfolio_fills WHERE instance_id = ? AND ts >= ? AND ts <= ?${symbolClause}
         ORDER BY ts DESC LIMIT ${limit}
       ) ORDER BY ts ASC`,
      rangeParams,
    )
    const allFillRows = await this.db.all<FillRow>(
      `SELECT * FROM (
         SELECT * FROM portfolio_fills WHERE instance_id = ? AND ts <= ?${query.symbol ? ' AND symbol = ?' : ''}
         ORDER BY ts DESC LIMIT 10000
       ) ORDER BY ts ASC`,
      query.symbol ? [this.instanceId, to, query.symbol] : [this.instanceId, to],
    )
    const decisionRows = await this.db.all<DecisionRow>(
      `SELECT * FROM (
         SELECT * FROM portfolio_decisions WHERE instance_id = ? AND ts >= ? AND ts <= ?${symbolClause}
         ORDER BY ts DESC LIMIT ${limit}
       ) ORDER BY ts ASC`,
      rangeParams,
    )
    const marketRows = await this.db.all<MarketBarRow>(
      `SELECT * FROM (
         SELECT * FROM portfolio_market_bars WHERE instance_id = ? AND ts >= ? AND ts <= ?${symbolClause}
         ORDER BY ts DESC LIMIT ${limit}
       ) ORDER BY ts ASC`,
      rangeParams,
    )
    const fills = fillRows.map(fillFromRow)
    const trades = aggregateTrades(allFillRows.map(fillFromRow))
      .filter(trade => trade.openedAt <= to && (trade.closedAt ?? to) >= from)
    const closed = trades.filter(trade => trade.status === 'closed')
    const winning = closed.filter(trade => trade.netPnlUsd > 0)
    const losing = closed.filter(trade => trade.netPnlUsd < 0)
    const grossWins = winning.reduce((sum, trade) => sum + trade.netPnlUsd, 0)
    const grossLosses = Math.abs(losing.reduce((sum, trade) => sum + trade.netPnlUsd, 0))
    const current = snapshotFromRow(latest)
    return {
      summary: {
        ...current,
        positions: query.symbol ? current.positions.filter(position => position.symbol === query.symbol) : current.positions,
        maxDrawdownPct,
        closedTrades: closed.length,
        winningTrades: winning.length,
        losingTrades: losing.length,
        winRatePct: closed.length > 0 ? winning.length / closed.length * 100 : 0,
        profitFactor: grossLosses > EPSILON ? grossWins / grossLosses : grossWins > 0 ? null : 0,
      },
      equity,
      fills,
      trades,
      decisions: decisionRows.map(decisionFromRow),
      marketBars: marketRows.map(row => ({
        symbol: row.symbol,
        timestamp: row.ts,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
      })),
    }
  }
}
