import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import { createLogger } from '../utils/logger.js'
import {
  USD_ASSETS, attachFunding, replayPositions, summarize, toFillRow, toOrderRow,
  type FillHistoryRow, type HistorySummary, type LedgerFill, type LedgerFunding, type OrderHistoryRow, type PositionHistoryRow,
} from './accountHistory.js'

const log = createLogger('PnlService')

/**
 * Per-instance PnL attribution.
 *
 * WHY order-level: several instances legitimately trade the same symbol on
 * the same account, so symbol-level income attribution mixes their books.
 * The venue order id is the one key that stays separable end to end:
 * executors CLAIM the ids they place (instanceId is on every instruction),
 * and a background collector joins the venue's own fills — the ground truth
 * for realized PnL and fees — back through those claims.
 *
 * WHY a collector, not the execution path: order placement is latency-critical
 * (measured in tens of ms around settlements) and fill reports on some venues
 * arrive asynchronously anyway. Claims are fire-and-forget inserts; the
 * collector runs on its own clock (interval + a debounced kick after
 * executions) and is idempotent — fills and funding events dedup on venue ids,
 * watermarks make refetches cheap.
 *
 * FUNDING attribution: funding is position-level. Each event is split across
 * the instances holding claimed exposure on that symbol at the event's time,
 * proportionally to |net position| (per operator decision); a remainder or a
 * fully unattributable event lands on instance_id '' so nothing silently
 * disappears.
 */

export interface OrderClaim {
  instanceId: string
  /** Credential name the order was placed with. */
  account: string
  symbol: string
  orderId: string
  executor?: string
  ts: number
}

/** Structural view of the adapter capabilities the collector uses — core cannot import venue packages. */
export interface PnlSessionLike {
  fetchFills?(symbol: string, since?: number, limit?: number): Promise<Array<{
    id: string; orderId: string; symbol: string; side: string; qty: number; price: number
    realizedPnl?: number; fee?: number; feeAsset?: string; timestamp: number
    info?: Record<string, unknown>
  }>>
  /**
   * Every symbol's fills in ONE call, for venues whose trade history is scoped
   * to the account rather than the market (Hyperliquid's `userFills` takes an
   * address, not a coin). Where it exists the sweep asks once instead of once
   * per symbol — on an account trading seventeen symbols that is seventeen
   * requests of the venue's rate budget reduced to one.
   */
  fetchFillsAll?(since?: number, limit?: number): Promise<Array<{
    id: string; orderId: string; symbol: string; side: string; qty: number; price: number
    realizedPnl?: number; fee?: number; feeAsset?: string; timestamp: number
    info?: Record<string, unknown>
  }>>
  fetchFundingHistory?(since?: number, limit?: number): Promise<Array<{
    id?: string; symbol: string; amount: number; asset: string; timestamp: number
  }>>
  fetchPositions?(symbols?: string[]): Promise<Array<{ symbol: string; markPrice: number }>>
  /**
   * Contracts this account traded since `since`, whoever placed the order —
   * read from the venue's account-wide income ledger. Optional: a venue
   * without one leaves discovery to claims and open positions.
   */
  fetchTradedSymbols?(since?: number, limit?: number): Promise<string[]>
}

/** One point on the realized-PnL curve: a timestamp and the running total. */
export interface PnlSeriesPoint {
  ts: number
  value: number
}

export interface PnlSummary {
  instanceId: string
  realized: number
  fees: number
  funding: number
  net: number
  fillCount: number
  firstTs: number | null
  lastTs: number | null
  bySymbol: Array<{ symbol: string; realized: number; fees: number; funding: number; net: number; fills: number }>
}

/** One instance's ledger over a rolling window — what a breaker judges. */
export interface PnlWindow {
  instanceId: string
  /** Window start, epoch ms. */
  since: number
  realized: number
  /** Already negated, like PnlSummary: a cost is a negative number. */
  fees: number
  funding: number
  net: number
  /** Every fill in the window, opens included. */
  fills: number
  /**
   * Fills that actually closed something — the only ones a win rate can be
   * computed over. An opening fill realizes nothing, and counting it as a
   * loss would drag every win rate toward zero.
   */
  closingFills: number
  wins: number
  /** wins / closingFills as a percentage, or null when nothing closed. */
  winRatePct: number | null
}

/**
 * Whether the ledger behind an instance is actually being kept up to date.
 *
 * The breaker must abstain when it is not. A collector that has stopped looks
 * exactly like a strategy that has stopped trading — flat PnL, no fills — and
 * acting on that reading would deactivate a healthy instance for the crime of
 * being unobserved.
 *
 * Watermarks are the signal because they advance on every cycle even when a
 * symbol is quiet: a cycle that finds no fills still pushes the mark forward
 * to now − FILL_RECHECK_MS. So a stale watermark means the cycle itself is
 * not happening, which is the thing worth refusing to act on.
 */
export interface LedgerHealth {
  live: boolean
  /** The oldest watermark among the instance's claimed pairs, epoch ms. */
  oldestMarkTs: number | null
  /** Claimed (account, symbol) pairs; 0 = the instance has never traded. */
  pairs: number
  stalePairs: number
  reason?: string
}

export interface PnlFillRow {
  symbol: string; side: string; qty: number; price: number
  realizedPnl: number | null; fee: number | null; feeAsset: string | null
  orderId: string; account: string; ts: number
}

export interface PnlPositionRow {
  symbol: string
  /** Net signed quantity derived from claimed fills (positive = long). */
  qty: number
  /** Average entry of the remaining position (fill-derived). */
  avgEntry: number
  account: string
  /** Venue mark price at read time; absent when the venue could not be queried. */
  markPrice?: number
  /** qty × (mark − avgEntry) — this instance's share of the open exposure. */
  unrealizedPnl?: number
}

export interface PnlServiceOptions {
  db: DatabaseAdapter
  /** Resolve a trading session for a credential name; null when unresolvable. */
  resolveSession(account: string): Promise<PnlSessionLike | null>
  /**
   * The safety sweep's interval, ms. Default 1 hour.
   *
   * Not the freshness knob it looks like: fills from THIS engine's own orders
   * arrive within `KICK_DEBOUNCE_MS` of the order being claimed. The sweep
   * exists for everything else — a position opened by hand, a liquidation, a
   * protective order some other client placed — and for those, an hour is
   * prompt enough while staying far inside the venue's serving window.
   */
  intervalMs?: number
  /** How far back the first collection reaches when no watermark exists. Default 3 days. */
  backfillMs?: number
}

const KICK_DEBOUNCE_MS = 30_000
/**
 * How far back a fills query may reach. Binance serves 7 days of userTrades;
 * six leaves a day of slack for a collector that was down overnight.
 */
const MAX_FILL_LOOKBACK_MS = 6 * 24 * 3600_000
/** Overlap kept when advancing past an empty window, for fills that land late. */
const FILL_RECHECK_MS = 10 * 60_000
/**
 * Rows asked for in one account-wide fill query. Hyperliquid serves at most
 * this many per call; a page that comes back this full was cut, and the
 * collector treats it as such rather than as "everything since the watermark".
 */
const FILLS_ALL_PAGE = 2000
/** Pages read in one sweep before giving the venue a rest. 5 × 2000 rows an hour is far past any account here. */
const FILLS_ALL_MAX_PAGES = 5
const EPS = 1e-9
/** Rows read per step when replaying a whole account, with a yield between steps. */
const HISTORY_PAGE = 20_000

/** Binance hedge mode tags each fill LONG/SHORT; one-way accounts say BOTH, which is no side at all. */
function hedgeSide(info: Record<string, unknown> | undefined): string | null {
  const v = String(info?.['positionSide'] ?? '').toUpperCase()
  return v === 'LONG' || v === 'SHORT' ? v : null
}

export interface HistoryQuery {
  since?: number
  until?: number
  symbol?: string
  offset?: number
  limit?: number
}

/** One slice of the ledger a history view covers. No symbol = the whole account. */
export interface HistoryMember {
  /** Ledger account key (the credential name). */
  ledger: string
  /** Shown in the rows' account column. */
  label: string
  symbol?: string
  side?: 'long' | 'short' | '*'
  /**
   * Only what this strategy instance placed. A combination derived from an
   * instance uses it, so another strategy trading the same symbol on the
   * same account stays out of its history.
   */
  instanceId?: string
}
export type HistoryScope = HistoryMember[]

export interface HistoryPage<T> {
  rows: T[]
  total: number
  summary: HistorySummary
}

type FillDbRow = {
  fill_id: string; order_id: string; instance_id: string | null; symbol: string; position_side: string | null
  side: string; qty: number; price: number; realized_pnl: number | null; fee: number | null; fee_asset: string | null; ts: number
}
const FILL_COLS = 'fill_id, order_id, instance_id, symbol, position_side, side, qty, price, realized_pnl, fee, fee_asset, ts'

/**
 * The side a hedge-mode fill belongs to when the ledger row predates the
 * column. Binance realizes PnL only on the closing leg, so a buy that
 * realized nothing opened a LONG and one that did closed a SHORT (and the
 * mirror for sells). Checked against every labelled fill on this install
 * (2026-09-17): 95 of 95. A close at exactly break-even is the one miss.
 */
export function inferHedgeSide(side: string, realizedPnl: number | null): 'LONG' | 'SHORT' {
  return (side === 'buy') === ((realizedPnl ?? 0) === 0) ? 'LONG' : 'SHORT'
}

function toLedgerFill(r: FillDbRow, hedge = false): LedgerFill {
  const positionSide = r.position_side ?? (hedge ? inferHedgeSide(r.side, r.realized_pnl) : null)
  return {
    fillId: r.fill_id, orderId: r.order_id, instanceId: r.instance_id, symbol: r.symbol, positionSide,
    side: r.side === 'sell' ? 'sell' : 'buy', qty: r.qty, price: r.price,
    realizedPnl: r.realized_pnl, fee: r.fee, feeAsset: r.fee_asset, ts: r.ts,
  }
}

function fillFilter(account: string, instanceId?: string): { sql: string; args: unknown[] } {
  return instanceId
    ? { sql: 'account = ? AND instance_id = ?', args: [account, instanceId] }
    : { sql: 'account = ?', args: [account] }
}

/** Replayed positions of one account, kept until the ledger grows. */
interface PositionCache {
  maxRowid: number
  hedge: boolean
  /** `${symbol}\u0000${positionSide}` → that book's positions, funding not yet attached. */
  books: Map<string, PositionHistoryRow[]>
}

export class PnlService {
  private readonly db: DatabaseAdapter
  private readonly resolveSession: PnlServiceOptions['resolveSession']
  private readonly intervalMs: number
  private readonly backfillMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private kickTimer: ReturnType<typeof setTimeout> | null = null
  private collecting = false
  private pending = new Map<string, Set<string>>()
  private pendingSweep = false
  /**
   * Paused by the operator: no periodic sweep and no claim-triggered pass.
   * Claims are still recorded — they are one cheap row each and they are
   * what attribution is built from — so resuming catches up with one sweep
   * and nothing is lost. An explicit collect() still runs while paused.
   */
  private paused = false
  private lastCollect: { at: number; ms: number } | undefined

  constructor(options: PnlServiceOptions) {
    this.db = options.db
    this.resolveSession = options.resolveSession
    /*
     * Ten minutes, not an hour.
     *
     * The circuit breaker reads this ledger, and a breaker cannot react faster
     * than the data it judges — an hourly collector makes "loss over the last
     * 15 minutes" a sentence with no meaning behind it. The cost is bounded by
     * the one venue that has no bulk endpoint: only Hyperliquid implements
     * fetchFillsAll, so Binance costs one fetchMyTrades per claimed symbol per
     * cycle. At ~156 claimed symbols that is ~78 weight/minute against a
     * 2400/minute budget, and collect() already refuses to overlap itself.
     */
    this.intervalMs = options.intervalMs ?? (Number(process.env['OPENWHALE_PNL_INTERVAL_MS']) || 10 * 60_000)
    this.backfillMs = options.backfillMs ?? 3 * 24 * 3600_000
  }

  start(): void {
    if (this.timer || this.paused) return
    this.timer = setInterval(() => { void this.collect() }, this.intervalMs)
    this.timer.unref?.()
    log.info({ intervalMs: this.intervalMs }, 'PnL collector armed')
  }

  /**
   * Stop or resume the collector's own traffic. Pausing drops the pending
   * claim-triggered pass along with the timer; resuming re-arms the timer and
   * sweeps once, so fills that landed while paused reach the ledger now
   * rather than at the next interval.
   */
  setPaused(paused: boolean): void {
    if (paused === this.paused) return
    this.paused = paused
    if (paused) {
      this.stop()
      this.pending = new Map()
      this.pendingSweep = false
      log.warn('PnL collector paused — no venue fill or funding queries until resumed')
      return
    }
    this.start()
    log.info('PnL collector resumed — sweeping once to catch up')
    void this.collect()
  }

  status(): { paused: boolean; collecting: boolean; intervalMs: number; lastCollectAt?: number; lastCollectMs?: number } {
    return {
      paused: this.paused,
      collecting: this.collecting,
      intervalMs: this.intervalMs,
      ...(this.lastCollect ? { lastCollectAt: this.lastCollect.at, lastCollectMs: this.lastCollect.ms } : {}),
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.kickTimer) { clearTimeout(this.kickTimer); this.kickTimer = null }
  }

  // ── Claims (called from the execution path — must stay cheap) ─────────────

  async recordClaim(claim: OrderClaim): Promise<void> {
    try {
      await this.db.run(
        `INSERT OR IGNORE INTO pnl_order_claims (account, order_id, instance_id, symbol, executor, ts)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [claim.account, claim.orderId, claim.instanceId, claim.symbol, claim.executor ?? null, claim.ts],
      )
      this.kick(claim.account, claim.symbol)
    } catch (err) {
      log.warn({ err, orderId: claim.orderId }, 'Order claim insert failed — that order will show as unattributed')
    }
  }

  /**
   * Collect what a fresh claim named, shortly.
   *
   * Scoped, because the claim knows exactly which account and symbol just
   * traded and a sweep of everything else answers a question nobody asked: one
   * order on one symbol used to re-query every symbol of every account —
   * around 180 requests of venue rate budget, every thirty seconds, for one
   * fill. The debounce still coalesces a burst of orders into one pass.
   */
  kick(account?: string, symbol?: string): void {
    if (this.paused) return
    if (account !== undefined && symbol !== undefined) {
      const symbols = this.pending.get(account) ?? new Set<string>()
      symbols.add(symbol)
      this.pending.set(account, symbols)
    } else {
      // No scope offered — the caller wants everything.
      this.pendingSweep = true
    }
    if (this.kickTimer) return
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null
      const scope = this.pending
      const sweep = this.pendingSweep
      this.pending = new Map()
      this.pendingSweep = false
      void (sweep ? this.collect() : this.collectScoped(scope))
    }, KICK_DEBOUNCE_MS)
    this.kickTimer.unref?.()
  }

  /** The claimed (account, symbol) pairs waiting for the next debounced pass. */
  private async collectScoped(scope: Map<string, Set<string>>): Promise<void> {
    if (this.collecting) {
      // A full sweep is already reading these very symbols; re-queue rather
      // than race it, since both write the same rows.
      for (const [account, symbols] of scope) for (const symbol of symbols) this.kick(account, symbol)
      return
    }
    this.collecting = true
    try {
      for (const [account, symbols] of scope) {
        try {
          const session = await this.resolveSession(account)
          if (!session?.fetchFills) continue
          for (const symbol of symbols) await this.collectSymbol(account, symbol, session)
        } catch (err) {
          log.warn({ err, account }, 'Scoped PnL collection failed — the next sweep picks it up')
        }
      }
    } finally {
      this.collecting = false
    }
  }

  // ── Collection ────────────────────────────────────────────────────────────

  async collect(): Promise<void> {
    if (this.collecting) return
    this.collecting = true
    const started = Date.now()
    try {
      const accounts = await this.db.all<{ account: string }>(
        `SELECT DISTINCT account FROM pnl_order_claims`)
      for (const { account } of accounts) {
        try {
          await this.collectAccount(account)
        } catch (err) {
          log.warn({ err, account }, 'PnL collection failed for account — next cycle retries')
        }
      }
    } finally {
      this.collecting = false
      this.lastCollect = { at: started, ms: Date.now() - started }
    }
  }

  private async collectAccount(account: string): Promise<void> {
    const session = await this.resolveSession(account)
    if (!session?.fetchFills) return

    const symbols = await this.symbolsOf(account, session)

    if (session.fetchFillsAll) await this.collectAllSymbols(account, symbols, session)
    else for (const symbol of symbols) await this.collectSymbol(account, symbol, session)

    if (session.fetchFundingHistory) {
      const since = (await this.watermark(account, 'funding')) ?? Date.now() - this.backfillMs
      let events
      try {
        events = await session.fetchFundingHistory(since + 1, 1000)
      } catch (err) {
        log.warn({ err, account }, 'fetchFundingHistory failed — funding skipped this cycle')
        return
      }
      for (const ev of events) {
        await this.attributeFunding(account, ev)
      }
      if (events.length > 0) {
        await this.setWatermark(account, 'funding', Math.max(...events.map(e => e.timestamp)))
      }
    }
  }

  /**
   * Which contracts to read this account's fills for.
   *
   * Claims name what OpenWhale placed; the account holds and has held more
   * than that. Binance's trade history is per symbol, so a contract nobody
   * listed is a contract nobody reads: a hand-opened position on Binance
   * SubAccount 2 was missing from that account's history entirely, while the
   * older accounts looked complete only because the funding bot had already
   * traded nearly every contract the operator touched.
   *
   * Two discovery channels, both account-wide: what is open right now, and
   * the venue's income ledger (every commission, realized PnL and funding
   * payment carries its contract). What either finds is remembered, so the
   * symbol keeps being read after the ledger window has moved past it.
   */
  private async symbolsOf(account: string, session: PnlSessionLike): Promise<string[]> {
    const symbols = new Set((await this.db.all<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM pnl_order_claims WHERE account = ?`, [account])).map(r => r.symbol))
    for (const { symbol } of await this.db.all<{ symbol: string }>(
      `SELECT symbol FROM pnl_symbols WHERE account = ?`, [account])) symbols.add(symbol)

    const found: Array<[string, string]> = []
    if (session.fetchTradedSymbols) {
      /* The whole backfill window every sweep, not "since the last fill":
         a contract traded by hand and closed again leaves no fill in the
         ledger to measure from, so a window anchored on our own rows would
         never reach it. One account-wide call an hour is cheap. */
      try {
        const from = Date.now() - this.backfillMs
        for (const symbol of await session.fetchTradedSymbols(from)) found.push([symbol, 'ledger'])
      } catch (err) {
        log.warn({ err, account }, 'Traded-symbol discovery failed — this sweep reads the symbols already known')
      }
    }
    if (session.fetchPositions) {
      try {
        for (const p of await session.fetchPositions()) if (p.symbol) found.push([p.symbol, 'position'])
      } catch (err) {
        log.warn({ err, account }, 'Position read failed — this sweep reads the symbols already known')
      }
    }
    const now = Date.now()
    for (const [symbol, source] of found) {
      if (symbols.has(symbol)) continue
      symbols.add(symbol)
      log.info({ account, symbol, source }, 'A contract this account traded was not being read — added')
      await this.db.run(
        `INSERT OR IGNORE INTO pnl_symbols (account, symbol, source, first_ts) VALUES (?, ?, ?, ?)`,
        [account, symbol, source, now])
    }
    return [...symbols]
  }

  /**
   * One symbol's new fills, from its own watermark.
   *
   * The watermark is per symbol and the venue's window is finite, so the two
   * hazards below are about the watermark, not the fills.
   */
  private async collectSymbol(account: string, symbol: string, session: PnlSessionLike): Promise<void> {
    if (!session.fetchFills) return
    /*
     * A watermark that falls outside the venue's serving window is a trap
     * that closes behind you.
     *
     * Binance answers fetchMyTrades for the last 7 days only. Once a
     * symbol's watermark is older than that, every query starts outside the
     * range, comes back empty, and — because the watermark only advanced on
     * a non-empty result — stays exactly where it was. The symbol then falls
     * further behind for ever, silently: the error is not an error, it is an
     * empty list.
     *
     * COTI on this install sat at 2026-08-14 while its executor kept
     * claiming order ids every hour. Ten days of fills never reached the
     * ledger, so every report read funding with no trades against it and
     * called a losing week a profit.
     */
    const since = await this.fillsSince(account, symbol)
    let fills
    try {
      fills = await session.fetchFills(symbol, since + 1, 1000)
    } catch (err) {
      log.warn({ err, account, symbol }, 'fetchFills failed — symbol skipped this cycle')
      return
    }
    if (fills.length === 0) {
      await this.advanceEmpty(account, symbol, since)
      return
    }
    await this.recordFills(account, symbol, fills)
    await this.setWatermark(account, `fills:${symbol}`, Math.max(...fills.map(f => f.timestamp)))
  }

  /**
   * Every symbol at once, for a venue whose fills are account-scoped.
   *
   * One query from the OLDEST symbol watermark, then the rows are filed by the
   * symbol they name — including symbols nothing claimed, which is how a
   * position opened by hand still reaches the ledger. Each symbol's watermark
   * still advances on its own, so switching a venue between this path and the
   * per-symbol one changes nothing about what is recorded.
   */
  private async collectAllSymbols(account: string, claimed: string[], session: PnlSessionLike): Promise<void> {
    if (!session.fetchFillsAll) return
    const sinceBySymbol = new Map<string, number>()
    for (const symbol of claimed) sinceBySymbol.set(symbol, await this.fillsSince(account, symbol))
    const since = sinceBySymbol.size > 0
      ? Math.min(...sinceBySymbol.values())
      : Math.max(Date.now() - this.backfillMs, Date.now() - MAX_FILL_LOOKBACK_MS)

    /*
     * Page through the venue's answer until a page comes back short. A full
     * page means the venue had more; the next page starts at that page's last
     * timestamp — inclusive, so fills sharing the boundary instant are not
     * stepped over, with INSERT OR IGNORE absorbing the one row seen twice.
     * Bounded, because a venue that answers every page full would otherwise
     * be read for ever; past the bound the sweep simply resumes next hour.
     */
    type Rows = Awaited<ReturnType<NonNullable<PnlSessionLike['fetchFillsAll']>>>
    const fills: Rows = []
    let complete = false
    try {
      let cursor = since + 1
      for (let page = 0; page < FILLS_ALL_MAX_PAGES; page++) {
        const rows = await session.fetchFillsAll(cursor, FILLS_ALL_PAGE)
        fills.push(...rows)
        if (rows.length < FILLS_ALL_PAGE) { complete = true; break }
        cursor = Math.max(...rows.map(f => f.timestamp))
      }
    } catch (err) {
      if (fills.length === 0) {
        log.warn({ err, account }, 'fetchFillsAll failed — falling back to one query per symbol')
        for (const symbol of claimed) await this.collectSymbol(account, symbol, session)
        return
      }
      // Some pages arrived before the failure: file them, and treat the read as
      // unfinished so no quiet-looking symbol is advanced past what was not seen.
      log.warn({ err, account, rows: fills.length }, 'fetchFillsAll failed mid-way — filing what arrived')
    }
    const pageEnd = fills.length > 0 ? Math.max(...fills.map(f => f.timestamp)) : since
    if (!complete) log.info({ account, rows: fills.length, pageEnd: new Date(pageEnd).toISOString() }, 'Fill history not fully read this sweep — resumes next hour')

    const bySymbol = new Map<string, typeof fills>()
    for (const f of fills) {
      const rows = bySymbol.get(f.symbol) ?? []
      rows.push(f)
      bySymbol.set(f.symbol, rows)
    }
    for (const [symbol, rows] of bySymbol) {
      // A fill older than this symbol's own watermark is already recorded;
      // INSERT OR IGNORE makes replaying it harmless, so it is filed anyway
      // rather than dropped on an off-by-one. The watermark never moves back:
      // one query from the OLDEST symbol can return, for a newer symbol, only
      // rows it already has.
      await this.recordFills(account, symbol, rows)
      const newest = Math.max(...rows.map(f => f.timestamp))
      await this.setWatermark(account, `fills:${symbol}`, Math.max(newest, sinceBySymbol.get(symbol) ?? 0))
    }
    for (const symbol of claimed) {
      if (bySymbol.has(symbol)) continue
      const own = sinceBySymbol.get(symbol) ?? since
      // Read to the end and the symbol was not there: quiet, advance as usual.
      // Read cut short and the symbol was not there: unknown, advance only to
      // where the reading stopped.
      if (complete) await this.advanceEmpty(account, symbol, own)
      else await this.setWatermark(account, `fills:${symbol}`, Math.max(own, pageEnd))
    }
  }

  /** Where a symbol's next query starts, clamped to what the venue still serves. */
  private async fillsSince(account: string, symbol: string): Promise<number> {
    const stale = (await this.watermark(account, `fills:${symbol}`)) ?? Date.now() - this.backfillMs
    const floor = Date.now() - MAX_FILL_LOOKBACK_MS
    if (stale < floor) {
      log.warn({
        account, symbol,
        watermark: new Date(stale).toISOString(),
        skippedMs: floor - stale,
      }, 'Fill watermark older than the venue serves — advancing past the gap; those fills are unrecoverable')
    }
    return Math.max(stale, floor)
  }

  /*
   * Advance on empty too, or a symbol that simply had a quiet week walks
   * into the same trap: its watermark stays put until it is older than
   * the window, and from then on it can never come back.
   *
   * Only to now − RECHECK, never to now: a fill can reach the venue's
   * trade endpoint slightly after it happened, and jumping the watermark
   * to the present would step over it.
   */
  private async advanceEmpty(account: string, symbol: string, since: number): Promise<void> {
    await this.setWatermark(account, `fills:${symbol}`, Math.max(since, Date.now() - FILL_RECHECK_MS))
  }

  /** File fills against the instance that claimed their order, or as unattributed. */
  private async recordFills(
    account: string,
    symbol: string,
    fills: Array<{ id: string; orderId: string; symbol: string; side: string; qty: number; price: number
      realizedPnl?: number; fee?: number; feeAsset?: string; timestamp: number; info?: Record<string, unknown> }>,
  ): Promise<void> {
    for (const f of fills) {
      const claim = await this.db.get<{ instance_id: string }>(
        `SELECT instance_id FROM pnl_order_claims WHERE account = ? AND order_id = ?`,
        [account, f.orderId])
      await this.db.run(
        `INSERT OR IGNORE INTO pnl_fills
           (account, fill_id, order_id, instance_id, symbol, side, qty, price, realized_pnl, fee, fee_asset, ts, position_side)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [account, f.id, f.orderId, claim?.instance_id ?? null, f.symbol || symbol,
          f.side === 'sell' ? 'sell' : 'buy', f.qty, f.price,
          f.realizedPnl ?? null, f.fee ?? null, f.feeAsset ?? null, f.timestamp, hedgeSide(f.info)])
    }
  }

  /** Split one funding event across instances by |net claimed position| at its time. */
  private async attributeFunding(
    account: string,
    ev: { id?: string; symbol: string; amount: number; asset: string; timestamp: number },
  ): Promise<void> {
    const eventKey = ev.id ?? `${ev.timestamp}:${ev.symbol}:${ev.amount}`
    // Entitlement freezes at the settlement boundary, but the venue stamps the
    // income slightly AFTER it — by then a settlement-scalping instance has
    // already closed and its net at ev.timestamp reads zero. Split by the
    // position held AT the boundary instead.
    const boundary = Math.min(ev.timestamp, Math.floor(ev.timestamp / 3600_000) * 3600_000)
    const exposures = await this.db.all<{ instance_id: string; net: number }>(
      `SELECT instance_id, SUM(CASE WHEN side = 'buy' THEN qty ELSE -qty END) AS net
         FROM pnl_fills
        WHERE account = ? AND symbol = ? AND ts <= ? AND instance_id IS NOT NULL
        GROUP BY instance_id`,
      [account, ev.symbol, boundary])
    const holders = exposures.filter(e => Math.abs(e.net) > EPS)
    const totalAbs = holders.reduce((s, e) => s + Math.abs(e.net), 0)

    if (totalAbs < EPS) {
      await this.db.run(
        `INSERT OR IGNORE INTO pnl_funding (account, event_key, instance_id, symbol, amount, asset, shared, ts)
         VALUES (?, ?, '', ?, ?, ?, 0, ?)`,
        [account, eventKey, ev.symbol, ev.amount, ev.asset, ev.timestamp])
      return
    }
    const shared = holders.length > 1 ? 1 : 0
    for (const h of holders) {
      const share = ev.amount * (Math.abs(h.net) / totalAbs)
      await this.db.run(
        `INSERT OR IGNORE INTO pnl_funding (account, event_key, instance_id, symbol, amount, asset, shared, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [account, eventKey, h.instance_id, ev.symbol, share, ev.asset, shared, ev.timestamp])
    }
  }

  // ── Aggregation ───────────────────────────────────────────────────────────

  async instancePnl(instanceId: string): Promise<PnlSummary> {
    const bySymbol = await this.db.all<{
      symbol: string; realized: number | null; fees: number | null; fills: number
      first_ts: number | null; last_ts: number | null
    }>(
      `SELECT symbol,
              SUM(realized_pnl) AS realized,
              SUM(fee)          AS fees,
              COUNT(*)          AS fills,
              MIN(ts) AS first_ts, MAX(ts) AS last_ts
         FROM pnl_fills WHERE instance_id = ? GROUP BY symbol`,
      [instanceId])
    const fundingBySymbol = await this.db.all<{ symbol: string; funding: number | null }>(
      `SELECT symbol, SUM(amount) AS funding FROM pnl_funding WHERE instance_id = ? GROUP BY symbol`,
      [instanceId])
    const fundingMap = new Map(fundingBySymbol.map(r => [r.symbol, r.funding ?? 0]))

    const rows = new Map<string, { symbol: string; realized: number; fees: number; funding: number; net: number; fills: number }>()
    for (const r of bySymbol) {
      rows.set(r.symbol, {
        symbol: r.symbol,
        realized: r.realized ?? 0,
        fees: -(r.fees ?? 0),
        funding: fundingMap.get(r.symbol) ?? 0,
        net: 0,
        fills: r.fills,
      })
    }
    for (const [symbol, funding] of fundingMap) {
      if (!rows.has(symbol)) rows.set(symbol, { symbol, realized: 0, fees: 0, funding, net: 0, fills: 0 })
    }
    let realized = 0, fees = 0, funding = 0, fillCount = 0
    for (const r of rows.values()) {
      r.net = r.realized + r.fees + r.funding
      realized += r.realized; fees += r.fees; funding += r.funding; fillCount += r.fills
    }
    const span = bySymbol.reduce<{ first: number | null; last: number | null }>((acc, r) => ({
      first: acc.first === null ? r.first_ts : Math.min(acc.first, r.first_ts ?? acc.first),
      last: acc.last === null ? r.last_ts : Math.max(acc.last, r.last_ts ?? acc.last),
    }), { first: null, last: null })

    return {
      instanceId, realized, fees, funding,
      net: realized + fees + funding,
      fillCount,
      firstTs: span.first, lastTs: span.last,
      bySymbol: [...rows.values()].sort((a, b) => a.net - b.net),
    }
  }

  /**
   * Realized PnL over time for one instance — the curve behind the number.
   *
   * Built from the two ledgers that carry a timestamp, fills and funding, so
   * every point is evidence from the venue rather than a sampled snapshot of
   * some running total. It is CUMULATIVE and it is REALIZED: unrealized has no
   * history here, because nothing records what an open position was worth an
   * hour ago. That is why the series and the headline `net` can disagree while
   * a position is open — the caller should say which it is showing.
   *
   * Downsampled by taking every nth event rather than by bucketing time: the
   * events are what happened, and a strategy that traded twice should draw two
   * steps, not a smooth line through empty hours.
   */
  async instanceSeries(instanceId: string, maxPoints = 120): Promise<PnlSeriesPoint[]> {
    const rows = await this.db.all<{ ts: number; delta: number }>(
      `SELECT ts, (COALESCE(realized_pnl, 0) - COALESCE(fee, 0)) AS delta FROM pnl_fills WHERE instance_id = ?
       UNION ALL
       SELECT ts, amount AS delta FROM pnl_funding WHERE instance_id = ?
       ORDER BY ts`,
      // COALESCE, not `realized_pnl - fee`: both columns are nullable, and in
      // SQL a NULL on either side makes the whole expression NULL — which
      // would silently drop a real fill's PnL because its fee was missing.
      [instanceId, instanceId])
    if (rows.length === 0) return []

    const out: PnlSeriesPoint[] = []
    let acc = 0
    // Keep the last point whatever the stride, or the curve stops short of the
    // total it is meant to explain.
    const stride = Math.max(1, Math.ceil(rows.length / maxPoints))
    for (let i = 0; i < rows.length; i++) {
      acc += rows[i]!.delta ?? 0
      if (i % stride === 0 || i === rows.length - 1) out.push({ ts: rows[i]!.ts, value: acc })
    }
    return out
  }

  /** One-shot totals for EVERY instance — the list page badge, not the drill-down. */
  async allInstanceTotals(): Promise<Record<string, { realized: number; fees: number; funding: number; net: number; unrealized: number | null }>> {
    const fills = await this.db.all<{ instance_id: string; realized: number | null; fees: number | null }>(
      `SELECT instance_id, SUM(realized_pnl) AS realized, SUM(fee) AS fees
         FROM pnl_fills WHERE instance_id IS NOT NULL GROUP BY instance_id`)
    const funding = await this.db.all<{ instance_id: string; funding: number | null }>(
      `SELECT instance_id, SUM(amount) AS funding FROM pnl_funding WHERE instance_id != '' GROUP BY instance_id`)
    const out: Record<string, { realized: number; fees: number; funding: number; net: number; unrealized: number | null }> = {}
    const row = (id: string) => (out[id] ??= { realized: 0, fees: 0, funding: 0, net: 0, unrealized: null })
    for (const r of fills) {
      const o = row(r.instance_id)
      o.realized = r.realized ?? 0
      o.fees = -(r.fees ?? 0)
    }
    for (const r of funding) row(r.instance_id).funding = r.funding ?? 0
    // Unrealized: price each instance's open book off one venue read per account.
    const markCache = new Map<string, Map<string, number> | null>()
    for (const id of Object.keys(out)) {
      const positions = await this.instancePositionsRaw(id)
      if (positions.length === 0) { out[id]!.unrealized = 0; continue }
      await this.priceRows(positions, markCache)
      const priced = positions.filter(p => p.unrealizedPnl !== undefined)
      // null (not 0) when the venue was unreachable — the UI shows nothing rather than a lie
      out[id]!.unrealized = priced.length === positions.length
        ? priced.reduce((s, p) => s + p.unrealizedPnl!, 0)
        : null
    }
    for (const o of Object.values(out)) o.net = o.realized + o.fees + o.funding
    return out
  }

  /**
   * The ledger for one instance over `[since, now]`.
   *
   * Realized only. Unrealized PnL is deliberately excluded: it swings with the
   * mark on an open position, so a breaker fed by it would trip on a position
   * that is doing exactly what the strategy intends to hold.
   */
  async instanceWindow(instanceId: string, since: number): Promise<PnlWindow> {
    const row = await this.db.get<{
      realized: number | null; fees: number | null; fills: number
      closing: number | null; wins: number | null
    }>(
      `SELECT SUM(realized_pnl) AS realized,
              SUM(fee)          AS fees,
              COUNT(*)          AS fills,
              SUM(CASE WHEN realized_pnl IS NOT NULL AND realized_pnl <> 0 THEN 1 ELSE 0 END) AS closing,
              SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)                               AS wins
         FROM pnl_fills WHERE instance_id = ? AND ts >= ?`,
      [instanceId, since])
    const fundingRow = await this.db.get<{ funding: number | null }>(
      `SELECT SUM(amount) AS funding FROM pnl_funding WHERE instance_id = ? AND ts >= ?`,
      [instanceId, since])

    const realized = row?.realized ?? 0
    // `-(0)` is -0, which survives into JSON as 0 but compares unequal to it
    // and renders as "-0.00". Not worth debugging twice.
    const fees = row?.fees ? -row.fees : 0
    const funding = fundingRow?.funding ?? 0
    const closingFills = row?.closing ?? 0
    const wins = row?.wins ?? 0
    return {
      instanceId, since, realized, fees, funding,
      net: realized + fees + funding,
      fills: row?.fills ?? 0,
      closingFills, wins,
      winRatePct: closingFills > 0 ? (wins / closingFills) * 100 : null,
    }
  }

  /** See LedgerHealth. `maxAgeMs` defaults to three collection cycles. */
  async ledgerHealth(instanceId: string, maxAgeMs = this.intervalMs * 3): Promise<LedgerHealth> {
    const rows = await this.db.all<{ account: string; symbol: string; ts: number | null }>(
      `SELECT c.account, c.symbol, w.ts
         FROM (SELECT DISTINCT account, symbol FROM pnl_order_claims WHERE instance_id = ?) c
         LEFT JOIN pnl_watermarks w
                ON w.account = c.account AND w.scope = 'fills:' || c.symbol`,
      [instanceId])
    if (rows.length === 0)
      return { live: false, oldestMarkTs: null, pairs: 0, stalePairs: 0, reason: 'instance has claimed no fills yet' }

    const floor = Date.now() - maxAgeMs
    let oldest: number | null = null
    let stale = 0
    for (const r of rows) {
      if (r.ts === null) { stale++; continue }
      if (r.ts < floor) stale++
      if (oldest === null || r.ts < oldest) oldest = r.ts
    }
    if (stale > 0) {
      return {
        live: false, oldestMarkTs: oldest, pairs: rows.length, stalePairs: stale,
        reason: `${stale}/${rows.length} claimed symbols have no fresh watermark — the collector is behind or stopped`,
      }
    }
    return { live: true, oldestMarkTs: oldest, pairs: rows.length, stalePairs: 0 }
  }

  async instanceFills(instanceId: string, limit = 200): Promise<PnlFillRow[]> {
    const rows = await this.db.all<{
      symbol: string; side: string; qty: number; price: number
      realized_pnl: number | null; fee: number | null; fee_asset: string | null
      order_id: string; account: string; ts: number
    }>(
      `SELECT symbol, side, qty, price, realized_pnl, fee, fee_asset, order_id, account, ts
         FROM pnl_fills WHERE instance_id = ? ORDER BY ts DESC LIMIT ?`,
      [instanceId, limit])
    return rows.map(r => ({
      symbol: r.symbol, side: r.side, qty: r.qty, price: r.price,
      realizedPnl: r.realized_pnl, fee: r.fee, feeAsset: r.fee_asset,
      orderId: r.order_id, account: r.account, ts: r.ts,
    }))
  }

  /** Net open positions per symbol, priced at the venue mark when reachable. */
  async instancePositions(instanceId: string): Promise<PnlPositionRow[]> {
    const rows = await this.instancePositionsRaw(instanceId)
    await this.priceRows(rows, new Map())
    return rows
  }

  /**
   * Attach markPrice/unrealizedPnl to derived rows. `markCache` lets callers
   * pricing many instances reuse one venue read per account.
   */
  private async priceRows(rows: PnlPositionRow[], markCache: Map<string, Map<string, number> | null>): Promise<void> {
    const byAccount = new Map<string, PnlPositionRow[]>()
    for (const r of rows) (byAccount.get(r.account) ?? byAccount.set(r.account, []).get(r.account)!).push(r)
    for (const [account, list] of byAccount) {
      let marks = markCache.get(account)
      if (marks === undefined) {
        marks = null
        try {
          const session = await this.resolveSession(account)
          if (session?.fetchPositions) {
            // Unfiltered read so the cached map serves every instance on this account.
            const positions = await session.fetchPositions()
            marks = new Map(positions.map(p => [p.symbol, p.markPrice]))
          }
        } catch (err) {
          log.warn({ account, err }, 'Mark-price read failed — positions stay unpriced')
        }
        markCache.set(account, marks)
      }
      if (!marks) continue
      for (const r of list) {
        const mark = marks.get(r.symbol)
        if (mark === undefined || !(mark > 0)) continue
        r.markPrice = mark
        r.unrealizedPnl = r.qty * (mark - r.avgEntry)
      }
    }
  }

  /** Net open positions per symbol, derived purely from this instance's claimed fills. */
  private async instancePositionsRaw(instanceId: string): Promise<PnlPositionRow[]> {
    const fills = await this.db.all<{ account: string; symbol: string; side: string; qty: number; price: number }>(
      `SELECT account, symbol, side, qty, price FROM pnl_fills WHERE instance_id = ? ORDER BY ts ASC`,
      [instanceId])
    const books = new Map<string, { account: string; symbol: string; qty: number; cost: number }>()
    for (const f of fills) {
      const key = `${f.account}:${f.symbol}`
      const b = books.get(key) ?? { account: f.account, symbol: f.symbol, qty: 0, cost: 0 }
      const signed = f.side === 'buy' ? f.qty : -f.qty
      if (b.qty === 0 || Math.sign(b.qty) === Math.sign(signed)) {
        // extend the position — cost tracks the absolute basis
        b.cost += f.qty * f.price
        b.qty += signed
      } else {
        // reduce (or flip): basis shrinks proportionally to the closed share
        const closing = Math.min(Math.abs(signed), Math.abs(b.qty))
        const avg = Math.abs(b.qty) > EPS ? b.cost / Math.abs(b.qty) : 0
        b.cost -= avg * closing
        b.qty += signed
        if (Math.sign(b.qty) === Math.sign(signed) && Math.abs(b.qty) > EPS) {
          // flipped through zero — remainder opens a fresh book at this fill's price
          b.cost = Math.abs(b.qty) * f.price
        }
      }
      books.set(key, b)
    }
    return [...books.values()]
      .filter(b => Math.abs(b.qty) > EPS)
      .map(b => ({
        account: b.account, symbol: b.symbol, qty: b.qty,
        avgEntry: Math.abs(b.qty) > EPS ? b.cost / Math.abs(b.qty) : 0,
      }))
  }

  // ── Account history ───────────────────────────────────────────────────────

  private readonly positionCache = new Map<string, PositionCache>()
  private readonly positionBuilds = new Map<string, Promise<PositionCache>>()
  private readonly hedgeAccounts = new Set<string>()

  /** An account is hedge-mode once any of its fills carries a side; sticky, since that never goes back. */
  private async isHedge(account: string): Promise<boolean> {
    if (this.hedgeAccounts.has(account)) return true
    const row = await this.db.get<{ ps: string }>(
      `SELECT position_side AS ps FROM pnl_fills WHERE account = ? AND position_side IS NOT NULL ORDER BY ts DESC LIMIT 1`, [account])
    if (row) this.hedgeAccounts.add(account)
    return row !== undefined
  }

  /** Symbols a scope has traded, for a filter. */
  async historySymbols(scope: HistoryScope): Promise<string[]> {
    const w = await this.scopeWhere(scope, {})
    const rows = await this.db.all<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM pnl_fills WHERE ${w.sql} ORDER BY symbol`, w.args)
    return rows.map(r => r.symbol)
  }

  /**
   * One WHERE for a scope: its members OR-ed, the window AND-ed on top.
   *
   * A member's side can be matched per fill only on a hedge-mode ledger, where
   * every fill belongs to LONG or SHORT (older rows by inference, the same
   * expression as `inferHedgeSide`). On a one-way ledger a buy can open a long
   * or close a short, so fills and orders there take the whole symbol; the
   * position view, which knows each position's side, still filters exactly.
   */
  private async scopeWhere(scope: HistoryScope, q: HistoryQuery): Promise<{ sql: string; args: unknown[] }> {
    const ors: string[] = []
    const args: unknown[] = []
    for (const m of scope) {
      const parts = ['account = ?']
      args.push(m.ledger)
      if (m.symbol) { parts.push('symbol = ?'); args.push(m.symbol) }
      if (m.instanceId) { parts.push('instance_id = ?'); args.push(m.instanceId) }
      if (m.side && m.side !== '*' && await this.isHedge(m.ledger)) {
        parts.push(`COALESCE(position_side, CASE WHEN (side = 'buy') = (COALESCE(realized_pnl, 0) = 0) THEN 'LONG' ELSE 'SHORT' END) = ?`)
        args.push(m.side === 'long' ? 'LONG' : 'SHORT')
      }
      ors.push(`(${parts.join(' AND ')})`)
    }
    const parts = [ors.length > 0 ? `(${ors.join(' OR ')})` : '0']
    if (q.symbol) { parts.push('symbol = ?'); args.push(q.symbol) }
    if (q.since !== undefined) { parts.push('ts >= ?'); args.push(q.since) }
    if (q.until !== undefined) { parts.push('ts < ?'); args.push(q.until) }
    return { sql: parts.join(' AND '), args }
  }

  /** Funding over a scope's (account, symbol) pairs — per pair once, whatever sides the scope names. */
  private async fundingTotal(scope: HistoryScope, q: HistoryQuery): Promise<number> {
    const pairs = new Map<string, HistoryMember>()
    for (const m of scope) {
      pairs.set(`${m.ledger}\u0000${m.symbol ?? ''}\u0000${m.instanceId ?? ''}`, {
        ledger: m.ledger, label: m.label,
        ...(m.symbol ? { symbol: m.symbol } : {}), ...(m.instanceId ? { instanceId: m.instanceId } : {}),
      })
    }
    const w = await this.scopeWhere([...pairs.values()], q)
    const rows = await this.db.all<{ asset: string; amount: number }>(
      `SELECT asset, SUM(amount) AS amount FROM pnl_funding WHERE ${w.sql} GROUP BY asset`, w.args)
    return rows.filter(r => USD_ASSETS.has(r.asset.toUpperCase())).reduce((s, r) => s + r.amount, 0)
  }

  private async summaryOf(scope: HistoryScope, q: HistoryQuery, w: { sql: string; args: unknown[] }): Promise<HistorySummary> {
    const agg = await this.db.all<{ asset: string; n: number; volume: number; fee: number; realized: number; zero_volume: number }>(
      `SELECT UPPER(COALESCE(fee_asset, 'USDT')) AS asset, COUNT(*) AS n, SUM(qty * price) AS volume,
              SUM(COALESCE(fee, 0)) AS fee, SUM(COALESCE(realized_pnl, 0)) AS realized,
              SUM(CASE WHEN COALESCE(fee, 0) = 0 THEN qty * price ELSE 0 END) AS zero_volume
         FROM pnl_fills WHERE ${w.sql} GROUP BY 1`, w.args)
    const rows = agg.map(a => {
      const usd = USD_ASSETS.has(a.asset)
      return {
        volume: a.volume, realized: a.realized,
        fees: usd ? a.fee : 0,
        feesOther: usd || a.fee === 0 ? {} : { [a.asset]: a.fee },
        feeVolume: usd ? a.volume : a.zero_volume,
      }
    })
    const s = summarize(rows, await this.fundingTotal(scope, q))
    s.count = agg.reduce((n, a) => n + a.n, 0)
    return s
  }

  private labelOf(scope: HistoryScope): Map<string, string> {
    return new Map(scope.map(m => [m.ledger, m.label]))
  }

  /** Fills newest first; the summary covers every fill in the window, not just the page. */
  async historyFills(scope: HistoryScope, q: HistoryQuery = {}): Promise<HistoryPage<FillHistoryRow>> {
    const w = await this.scopeWhere(scope, q)
    const page = await this.db.all<FillDbRow & { account: string }>(
      `SELECT account, ${FILL_COLS} FROM pnl_fills WHERE ${w.sql} ORDER BY ts DESC, fill_id LIMIT ? OFFSET ?`,
      [...w.args, q.limit ?? 50, q.offset ?? 0])
    const labels = this.labelOf(scope)
    const rows: FillHistoryRow[] = []
    for (const r of page) rows.push({ ...toFillRow(toLedgerFill(r, await this.isHedge(r.account))), account: labels.get(r.account) ?? r.account })
    const summary = await this.summaryOf(scope, q, w)
    return { rows, total: summary.count, summary }
  }

  /** Fills grouped by venue order, newest first. */
  async historyOrders(scope: HistoryScope, q: HistoryQuery = {}): Promise<HistoryPage<OrderHistoryRow>> {
    const w = await this.scopeWhere(scope, q)
    const ids = await this.db.all<{ account: string; order_id: string; last_ts: number }>(
      `SELECT account, order_id, MAX(ts) AS last_ts FROM pnl_fills WHERE ${w.sql}
        GROUP BY account, order_id ORDER BY last_ts DESC, order_id LIMIT ? OFFSET ?`,
      [...w.args, q.limit ?? 50, q.offset ?? 0])
    const labels = this.labelOf(scope)
    const byOrder = new Map<string, { account: string; fills: LedgerFill[] }>(
      ids.map(i => [`${i.account}\u0000${i.order_id}`, { account: i.account, fills: [] }]))
    for (const account of new Set(ids.map(i => i.account))) {
      const mine = ids.filter(i => i.account === account).map(i => i.order_id)
      const hedge = await this.isHedge(account)
      const fills = await this.db.all<FillDbRow>(
        `SELECT ${FILL_COLS} FROM pnl_fills WHERE account = ? AND order_id IN (${mine.map(() => '?').join(',')}) ORDER BY ts`,
        [account, ...mine])
      for (const f of fills) byOrder.get(`${account}\u0000${f.order_id}`)?.fills.push(toLedgerFill(f, hedge))
    }
    const rows = [...byOrder.values()]
      .filter(o => o.fills.length > 0)
      .map(o => ({ ...toOrderRow(o.fills), account: labels.get(o.account) ?? o.account }))
    const count = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM pnl_fills WHERE ${w.sql} GROUP BY account, order_id)`, w.args)
    const summary = await this.summaryOf(scope, q, w)
    summary.count = count?.n ?? 0
    return { rows, total: summary.count, summary }
  }

  /**
   * Positions replayed from each ledger's whole history — a position's size
   * depends on every fill before it, so the window filters the result, never
   * the replay. Positions overlapping [since, until) are returned, newest
   * open first; the summary covers all of them.
   */
  async historyPositions(scope: HistoryScope, q: HistoryQuery = {}): Promise<HistoryPage<PositionHistoryRow> & { unmatchedFunding: number }> {
    let all: PositionHistoryRow[] = []
    let unmatchedFunding = 0
    const byBook = new Map<string, HistoryMember[]>()
    for (const m of scope) {
      const k = `${m.ledger}\u0000${m.instanceId ?? ''}`
      ;(byBook.get(k) ?? byBook.set(k, []).get(k)!).push(m)
    }
    for (const members of byBook.values()) {
      const { ledger, instanceId } = members[0]!
      const cache = await this.positionsFor(ledger, instanceId)
      const whole = members.some(m => !m.symbol)
      const symbols = new Set(members.map(m => m.symbol).filter((x): x is string => !!x))
      const mine: PositionHistoryRow[] = []
      for (const list of cache.books.values()) {
        if (list.length === 0 || !(whole || symbols.has(list[0]!.symbol))) continue
        mine.push(...list.map(p => ({ ...p, feesOther: { ...p.feesOther }, account: members[0]!.label })))
      }
      const funding = await this.db.all<{ symbol: string; amount: number; asset: string; ts: number }>(
        `SELECT symbol, SUM(amount) AS amount, asset, ts FROM pnl_funding WHERE account = ?
          ${instanceId ? 'AND instance_id = ?' : ''}
          ${whole ? '' : `AND symbol IN (${[...symbols].map(() => '?').join(',')})`} GROUP BY event_key`,
        [ledger, ...(instanceId ? [instanceId] : []), ...(whole ? [] : [...symbols])])
      unmatchedFunding += attachFunding(mine, funding as LedgerFunding[]).unmatched
      // Side filter after funding, so a hedge book's two legs still share their symbol's payments.
      all.push(...mine.filter(p => members.some(m =>
        (!m.symbol || m.symbol === p.symbol) && (!m.side || m.side === '*' || m.side === p.side))))
    }
    all = all.filter(p =>
      (!q.symbol || p.symbol === q.symbol)
      && (q.until === undefined || p.openTs < q.until)
      && (q.since === undefined || p.closeTs === null || p.closeTs >= q.since))
    all.sort((a, b) => (b.closeTs ?? Infinity) - (a.closeTs ?? Infinity) || b.openTs - a.openTs)
    const offset = q.offset ?? 0
    return {
      rows: all.slice(offset, offset + (q.limit ?? 50)),
      total: all.length,
      summary: summarize(all),
      unmatchedFunding,
    }
  }

  /** A ledger's positions — or, given an instance, only what that instance traded on it. */
  private async positionsFor(account: string, instanceId?: string): Promise<PositionCache> {
    const key = `${account}\u0000${instanceId ?? ''}`
    const filter = fillFilter(account, instanceId)
    const head = await this.db.get<{ r: number | null }>(`SELECT MAX(rowid) AS r FROM pnl_fills WHERE ${filter.sql}`, filter.args)
    const maxRowid = head?.r ?? 0
    const hedge = await this.isHedge(account)
    let cached = this.positionCache.get(key)
    if (cached && cached.hedge !== hedge) cached = undefined
    if (cached && cached.maxRowid === maxRowid) return cached
    const running = this.positionBuilds.get(key)
    if (running) return running
    const build = this.buildPositions(filter, cached, maxRowid, hedge)
      .then(c => { this.positionCache.set(key, c); return c })
      .finally(() => this.positionBuilds.delete(key))
    this.positionBuilds.set(key, build)
    return build
  }

  /**
   * Replay only the books that gained fills since the cached build — each
   * reread whole, because a late fill can land anywhere in its history. A
   * first build reads the ledger in rowid pages and yields between them, so
   * a large account does not hold the event loop the strategies run on.
   */
  private async buildPositions(filter: { sql: string; args: unknown[] }, prev: PositionCache | undefined, maxRowid: number, hedge: boolean): Promise<PositionCache> {
    const keyOf = (symbol: string, side: string | null) => `${symbol}\u0000${side ?? ''}`
    const books = new Map(prev?.books ?? [])
    const groups = new Map<string, LedgerFill[]>()
    const add = (f: LedgerFill) => {
      const k = keyOf(f.symbol, f.positionSide)
      const list = groups.get(k) ?? groups.set(k, []).get(k)!
      list.push(f)
    }
    if (prev) {
      // A symbol that gained fills is replayed whole, every side of it.
      const touched = await this.db.all<{ symbol: string }>(
        `SELECT DISTINCT symbol FROM pnl_fills WHERE ${filter.sql} AND rowid > ?`, [...filter.args, prev.maxRowid])
      for (const { symbol } of touched) {
        for (const k of [...books.keys()]) if (k.startsWith(`${symbol}\u0000`)) books.delete(k)
        const rows = await this.db.all<FillDbRow>(
          `SELECT ${FILL_COLS} FROM pnl_fills WHERE ${filter.sql} AND symbol = ? ORDER BY ts, rowid`, [...filter.args, symbol])
        for (const r of rows) add(toLedgerFill(r, hedge))
        await new Promise(r => setImmediate(r))
      }
    } else {
      let after = 0
      for (;;) {
        const rows = await this.db.all<FillDbRow & { rid: number }>(
          `SELECT rowid AS rid, ${FILL_COLS} FROM pnl_fills WHERE ${filter.sql} AND rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
          [...filter.args, after, maxRowid, HISTORY_PAGE])
        for (const r of rows) add(toLedgerFill(r, hedge))
        if (rows.length < HISTORY_PAGE) break
        after = rows[rows.length - 1]!.rid
        await new Promise(r => setImmediate(r))
      }
      for (const list of groups.values()) list.sort((a, b) => a.ts - b.ts)
    }
    let replayed = 0
    for (const [k, fills] of groups) {
      const [symbol, side] = k.split('\u0000') as [string, string]
      books.set(k, replayPositions(symbol, side || null, fills))
      replayed += fills.length
      if (replayed >= HISTORY_PAGE) { replayed = 0; await new Promise(r => setImmediate(r)) }
    }
    return { maxRowid, hedge, books }
  }

  // ── Watermarks ────────────────────────────────────────────────────────────

  private async watermark(account: string, scope: string): Promise<number | undefined> {
    const row = await this.db.get<{ ts: number }>(
      `SELECT ts FROM pnl_watermarks WHERE account = ? AND scope = ?`, [account, scope])
    return row?.ts
  }

  private async setWatermark(account: string, scope: string, ts: number): Promise<void> {
    await this.db.run(
      `INSERT INTO pnl_watermarks (account, scope, ts) VALUES (?, ?, ?)
       ON CONFLICT(account, scope) DO UPDATE SET ts = excluded.ts`,
      [account, scope, ts])
  }
}
