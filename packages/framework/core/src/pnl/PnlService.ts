import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import { createLogger } from '../utils/logger.js'

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
  }>>
  fetchFundingHistory?(since?: number, limit?: number): Promise<Array<{
    id?: string; symbol: string; amount: number; asset: string; timestamp: number
  }>>
  fetchPositions?(symbols?: string[]): Promise<Array<{ symbol: string; markPrice: number }>>
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
  /** Collector interval, ms. Default 5 min. */
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
const EPS = 1e-9

export class PnlService {
  private readonly db: DatabaseAdapter
  private readonly resolveSession: PnlServiceOptions['resolveSession']
  private readonly intervalMs: number
  private readonly backfillMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private kickTimer: ReturnType<typeof setTimeout> | null = null
  private collecting = false

  constructor(options: PnlServiceOptions) {
    this.db = options.db
    this.resolveSession = options.resolveSession
    this.intervalMs = options.intervalMs ?? 5 * 60_000
    this.backfillMs = options.backfillMs ?? 3 * 24 * 3600_000
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.collect() }, this.intervalMs)
    this.timer.unref?.()
    log.info({ intervalMs: this.intervalMs }, 'PnL collector armed')
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
      this.kick()
    } catch (err) {
      log.warn({ err, orderId: claim.orderId }, 'Order claim insert failed — that order will show as unattributed')
    }
  }

  /** Debounced collect after fresh executions, so PnL shows up in ~30s not ~5min. */
  kick(): void {
    if (this.kickTimer) return
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null
      void this.collect()
    }, KICK_DEBOUNCE_MS)
    this.kickTimer.unref?.()
  }

  // ── Collection ────────────────────────────────────────────────────────────

  async collect(): Promise<void> {
    if (this.collecting) return
    this.collecting = true
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
    }
  }

  private async collectAccount(account: string): Promise<void> {
    const session = await this.resolveSession(account)
    if (!session?.fetchFills) return

    const symbols = await this.db.all<{ symbol: string }>(
      `SELECT DISTINCT symbol FROM pnl_order_claims WHERE account = ?`, [account])

    for (const { symbol } of symbols) {
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
      const stale = (await this.watermark(account, `fills:${symbol}`)) ?? Date.now() - this.backfillMs
      const floor = Date.now() - MAX_FILL_LOOKBACK_MS
      const since = Math.max(stale, floor)
      if (stale < floor) {
        log.warn({
          account, symbol,
          watermark: new Date(stale).toISOString(),
          skippedMs: floor - stale,
        }, 'Fill watermark older than the venue serves — advancing past the gap; those fills are unrecoverable')
      }
      let fills
      try {
        fills = await session.fetchFills(symbol, since + 1, 1000)
      } catch (err) {
        log.warn({ err, account, symbol }, 'fetchFills failed — symbol skipped this cycle')
        continue
      }
      if (fills.length === 0) {
        /*
         * Advance on empty too, or a symbol that simply had a quiet week walks
         * into the same trap: its watermark stays put until it is older than
         * the window, and from then on it can never come back.
         *
         * Only to now − RECHECK, never to now: a fill can reach the venue's
         * trade endpoint slightly after it happened, and jumping the watermark
         * to the present would step over it.
         */
        await this.setWatermark(account, `fills:${symbol}`, Math.max(since, Date.now() - FILL_RECHECK_MS))
        continue
      }
      for (const f of fills) {
        const claim = await this.db.get<{ instance_id: string }>(
          `SELECT instance_id FROM pnl_order_claims WHERE account = ? AND order_id = ?`,
          [account, f.orderId])
        await this.db.run(
          `INSERT OR IGNORE INTO pnl_fills
             (account, fill_id, order_id, instance_id, symbol, side, qty, price, realized_pnl, fee, fee_asset, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [account, f.id, f.orderId, claim?.instance_id ?? null, f.symbol || symbol,
            f.side === 'sell' ? 'sell' : 'buy', f.qty, f.price,
            f.realizedPnl ?? null, f.fee ?? null, f.feeAsset ?? null, f.timestamp])
      }
      await this.setWatermark(account, `fills:${symbol}`, Math.max(...fills.map(f => f.timestamp)))
    }

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
