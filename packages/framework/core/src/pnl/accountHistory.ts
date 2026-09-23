/**
 * Account trade history read from the PnL ledger: fills, orders (fills
 * grouped by venue order id) and positions (fills replayed per symbol from
 * flat to flat).
 *
 * Fees count toward USD totals only when paid in a USD stablecoin. A fee paid
 * in BNB (Binance's discount) is reported per asset beside the total instead
 * of being converted at some price the ledger never recorded — a fee rate
 * built on a guessed conversion would look precise and be wrong.
 */

export const USD_ASSETS = new Set(['USD', 'USDT', 'USDC', 'USD1', 'FDUSD', 'USDE', 'BUSD', 'DAI'])

export interface LedgerFill {
  fillId: string
  orderId: string
  instanceId: string | null
  symbol: string
  /** 'LONG' / 'SHORT' on a hedge-mode account; null on one-way accounts and older rows. */
  positionSide: string | null
  side: 'buy' | 'sell'
  qty: number
  price: number
  realizedPnl: number | null
  fee: number | null
  feeAsset: string | null
  ts: number
}

export interface LedgerFunding {
  symbol: string
  amount: number
  asset: string
  ts: number
}

/** Fee split into what can be summed as USD and what cannot. */
export interface FeeTotals {
  /** Fees paid in USD stablecoins. Positive = paid; a maker rebate is negative. */
  fees: number
  /** Fees paid in any other asset, per asset, in that asset's units. */
  feesOther: Record<string, number>
  /** Traded notional whose fee was USD (or nothing) — the denominator of the fee rate. */
  feeVolume: number
}

export interface HistorySummary extends FeeTotals {
  count: number
  /** Σ qty × price over the fills behind the rows. */
  volume: number
  /** fees / volume over the fills whose fee was paid in USD; null when there are none. */
  feeRate: number | null
  realized: number
  funding: number
  /** realized − fees + funding (USD part only). */
  net: number
}

export interface FillHistoryRow extends FeeTotals {
  /** Which account the row came from, on a view spanning several. */
  account?: string
  fillId: string
  orderId: string
  instanceId: string | null
  symbol: string
  positionSide: string | null
  side: 'buy' | 'sell'
  qty: number
  price: number
  notional: number
  realizedPnl: number | null
  fee: number | null
  feeAsset: string | null
  /** fee / notional when the fee is in USD. */
  feeRate: number | null
  ts: number
}

export interface OrderHistoryRow extends FeeTotals {
  /** Which account the row came from, on a view spanning several. */
  account?: string
  orderId: string
  instanceId: string | null
  symbol: string
  positionSide: string | null
  side: 'buy' | 'sell'
  fills: number
  qty: number
  avgPrice: number
  notional: number
  realized: number
  feeRate: number | null
  firstTs: number
  lastTs: number
}

export interface PositionHistoryRow extends FeeTotals {
  /** Which account the row came from, on a view spanning several. */
  account?: string
  id: string
  symbol: string
  positionSide: string | null
  side: 'long' | 'short'
  openTs: number
  /** null = still open. */
  closeTs: number | null
  maxQty: number
  /** Largest size reached, at the average entry. */
  maxNotional: number
  avgEntry: number
  /** null until something was closed. */
  avgExit: number | null
  /** Size still held; 0 once closed. */
  openQty: number
  /**
   * Opened with the dust the previous round trip could not close, rather than
   * by a fill of its own. A carried row with no fills IS that leftover.
   */
  carried?: boolean
  fills: number
  orders: number
  volume: number
  realized: number
  funding: number
  net: number
  feeRate: number | null
  instanceIds: string[]
  /**
   * The ledger starts mid-position: the first fill already realized PnL, so
   * it reduced a position opened before collection began. Size, entry and
   * PnL of this row are incomplete.
   */
  partial: boolean
}

const REL_EPS = 1e-7
/**
 * What counts as flat.
 *
 * A round trip rarely lands on exactly zero: each close leaves a remainder
 * below the venue's lot step, and once that remainder is worth less than the
 * venue's minimum order it CANNOT be closed at all (Binance: $5). Requiring
 * an exact zero made every such remainder weld the next round trip onto the
 * last: on one high-frequency account a contract's 46 fills over four days —
 * dozens of separate round trips — were reported as ONE position that never
 * closed, with a "max size" thirty times anything actually held at once.
 *
 * So a position closes when what is left is dust — under five dollars, or
 * half a percent of the size it reached. The dust itself is not discarded: it
 * opens the next position, which is why the open rows still add up to what
 * the exchange holds.
 */
const DUST_USD = 5
const DUST_FRACTION = 0.005

export function feeRateOf(fees: number, usdFeeVolume: number): number | null {
  return usdFeeVolume > 0 ? fees / usdFeeVolume : null
}

function addFee(t: FeeTotals, fee: number | null, asset: string | null, share = 1): boolean {
  if (fee === null || fee === 0) return true
  const a = (asset ?? 'USDT').toUpperCase()
  if (USD_ASSETS.has(a)) { t.fees += fee * share; return true }
  t.feesOther[a] = (t.feesOther[a] ?? 0) + fee * share
  return false
}

export function toFillRow(f: LedgerFill): FillHistoryRow {
  const notional = f.qty * f.price
  const totals: FeeTotals = { fees: 0, feesOther: {}, feeVolume: 0 }
  if (addFee(totals, f.fee, f.feeAsset)) totals.feeVolume = notional
  return {
    fillId: f.fillId, orderId: f.orderId, instanceId: f.instanceId, symbol: f.symbol,
    positionSide: f.positionSide, side: f.side, qty: f.qty, price: f.price, notional,
    realizedPnl: f.realizedPnl, fee: f.fee, feeAsset: f.feeAsset,
    ...totals,
    feeRate: feeRateOf(totals.fees, totals.feeVolume),
    ts: f.ts,
  }
}

/** Fills of one order, any order of arrival. */
export function toOrderRow(fills: LedgerFill[]): OrderHistoryRow {
  const first = fills[0]!
  const row: OrderHistoryRow = {
    orderId: first.orderId, instanceId: first.instanceId, symbol: first.symbol,
    positionSide: first.positionSide, side: first.side,
    fills: fills.length, qty: 0, avgPrice: 0, notional: 0, realized: 0,
    fees: 0, feesOther: {}, feeVolume: 0, feeRate: null, firstTs: first.ts, lastTs: first.ts,
  }
  for (const f of fills) {
    row.qty += f.qty
    row.notional += f.qty * f.price
    row.realized += f.realizedPnl ?? 0
    if (addFee(row, f.fee, f.feeAsset)) row.feeVolume += f.qty * f.price
    if (f.ts < row.firstTs) row.firstTs = f.ts
    if (f.ts > row.lastTs) row.lastTs = f.ts
    row.instanceId ??= f.instanceId
  }
  row.avgPrice = row.qty > 0 ? row.notional / row.qty : 0
  row.feeRate = feeRateOf(row.fees, row.feeVolume)
  return row
}

interface OpenBook {
  row: PositionHistoryRow
  qty: number
  entryCost: number
  entryQty: number
  exitCost: number
  exitQty: number
  orders: Set<string>
  instances: Set<string>
}

/**
 * Replay one symbol's fills (one position side) oldest first. A position
 * opens when the book leaves flat and closes when it returns; a fill that
 * crosses through flat closes one position and opens the next, its fee and
 * PnL split by quantity.
 */
export function replayPositions(symbol: string, positionSide: string | null, fills: LedgerFill[]): PositionHistoryRow[] {
  const out: PositionHistoryRow[] = []
  let book: OpenBook | undefined

  const open = (f: LedgerFill, dir: 1 | -1, partial: boolean): OpenBook => ({
    row: {
      id: `${symbol}:${positionSide ?? ''}:${f.ts}:${f.fillId}`,
      symbol, positionSide, side: dir > 0 ? 'long' : 'short',
      openTs: f.ts, closeTs: null, maxQty: 0, maxNotional: 0, avgEntry: 0, avgExit: null, openQty: 0,
      fills: 0, orders: 0, volume: 0, realized: 0, funding: 0, net: 0,
      fees: 0, feesOther: {}, feeVolume: 0, feeRate: null, instanceIds: [], partial,
    },
    qty: 0, entryCost: 0, entryQty: 0, exitCost: 0, exitQty: 0,
    orders: new Set(), instances: new Set(),
  })

  const touch = (b: OpenBook, f: LedgerFill, qty: number, share: number) => {
    b.row.fills++
    b.row.volume += qty * f.price
    b.row.realized += (f.realizedPnl ?? 0) * share
    if (addFee(b.row, f.fee, f.feeAsset, share)) b.row.feeVolume += qty * f.price
    b.orders.add(f.orderId)
    if (f.instanceId) b.instances.add(f.instanceId)
  }

  const finish = (b: OpenBook, closeTs: number | null) => {
    const r = b.row
    r.closeTs = closeTs
    r.avgEntry = b.entryQty > 0 ? b.entryCost / b.entryQty : 0
    r.avgExit = b.exitQty > 0 ? b.exitCost / b.exitQty : null
    r.openQty = closeTs === null ? Math.abs(b.qty) : 0
    r.maxNotional = r.maxQty * (r.avgEntry || (r.avgExit ?? 0))
    r.orders = b.orders.size
    r.instanceIds = [...b.instances].sort()
    r.feeRate = feeRateOf(r.fees, r.feeVolume)
    out.push(r)
  }

  /*
   * Fills that realize PnL before anything was opened close a position the
   * ledger never saw open. They are gathered into one partial row — the
   * leading run on one side — and the replay proper starts flat after it.
   */
  let i = 0
  const lead = fills[0]
  if (lead && (lead.realizedPnl ?? 0) !== 0) {
    const pre = open(lead, lead.side === 'buy' ? -1 : 1, true)
    while (i < fills.length && fills[i]!.side === lead.side && (fills[i]!.realizedPnl ?? 0) !== 0) {
      const f = fills[i]!
      pre.exitCost += f.qty * f.price
      pre.exitQty += f.qty
      pre.row.maxQty += f.qty
      touch(pre, f, f.qty, 1)
      i++
    }
    finish(pre, fills[i - 1]!.ts)
  }

  for (; i < fills.length; i++) {
    const f = fills[i]!
    const signed = f.side === 'buy' ? f.qty : -f.qty
    book ??= open(f, signed > 0 ? 1 : -1, false)
    const dir = book.row.side === 'long' ? 1 : -1
    if (Math.sign(signed) === dir) {
      book.qty += signed
      book.entryCost += f.qty * f.price
      book.entryQty += f.qty
      book.row.maxQty = Math.max(book.row.maxQty, Math.abs(book.qty))
      touch(book, f, f.qty, 1)
      continue
    }
    const held = Math.abs(book.qty)
    const closing = Math.min(f.qty, held)
    const share = f.qty > 0 ? closing / f.qty : 1
    book.qty += dir * -closing
    book.exitCost += closing * f.price
    book.exitQty += closing
    touch(book, f, closing, share)
    const rest = f.qty - closing
    const left = Math.abs(book.qty)
    const flat = left <= REL_EPS * Math.max(1, book.row.maxQty)
      || left * f.price < DUST_USD
      || left <= DUST_FRACTION * book.row.maxQty
    if (flat) {
      const avgEntry = book.entryQty > 0 ? book.entryCost / book.entryQty : f.price
      const dust = flat && left > REL_EPS * Math.max(1, book.row.maxQty) ? book.qty : 0
      book.qty = 0
      finish(book, f.ts)
      book = undefined
      if (rest > REL_EPS * Math.max(1, f.qty)) {
        // The fill crossed through flat: its remainder opens the other side.
        book = open(f, -dir as 1 | -1, false)
        book.qty = -dir * rest
        book.entryCost = rest * f.price
        book.entryQty = rest
        book.row.maxQty = rest
        touch(book, f, rest, 1 - share)
      } else if (dust !== 0) {
        // Untradeable remainder: it is still held, so it becomes the next
        // position — open, with no fills of its own until one arrives.
        book = open(f, dust > 0 ? 1 : -1, false)
        book.qty = dust
        book.entryCost = Math.abs(dust) * avgEntry
        book.entryQty = Math.abs(dust)
        book.row.maxQty = Math.abs(dust)
        book.row.carried = true
      }
    }
  }
  if (book) finish(book, null)
  return out
}

/**
 * Funding lands on the position of that symbol open at the settlement
 * boundary (the venue stamps the payment a little after it). Several open at
 * once — both legs of a hedge-mode account — share it by size. Returns the
 * amount that matched no position.
 */
export function attachFunding(positions: PositionHistoryRow[], funding: LedgerFunding[]): { unmatched: number; unmatchedOther: Record<string, number> } {
  const bySymbol = new Map<string, PositionHistoryRow[]>()
  for (const p of positions) (bySymbol.get(p.symbol) ?? bySymbol.set(p.symbol, []).get(p.symbol)!).push(p)
  let unmatched = 0
  const unmatchedOther: Record<string, number> = {}
  for (const ev of funding) {
    const boundary = Math.min(ev.ts, Math.floor(ev.ts / 3600_000) * 3600_000)
    const holders = (bySymbol.get(ev.symbol) ?? []).filter(p => p.openTs <= boundary && (p.closeTs === null || p.closeTs > boundary))
    const usd = USD_ASSETS.has(ev.asset.toUpperCase())
    if (holders.length === 0) {
      if (usd) unmatched += ev.amount
      else unmatchedOther[ev.asset] = (unmatchedOther[ev.asset] ?? 0) + ev.amount
      continue
    }
    if (!usd) continue
    const total = holders.reduce((s, p) => s + p.maxQty, 0)
    for (const p of holders) p.funding += total > 0 ? ev.amount * (p.maxQty / total) : ev.amount / holders.length
  }
  for (const p of positions) p.net = p.realized - p.fees + p.funding
  return { unmatched, unmatchedOther }
}

export function summarize(
  rows: Array<FeeTotals & { volume?: number; notional?: number; realized?: number; realizedPnl?: number | null; funding?: number }>,
  funding = 0,
): HistorySummary {
  const s: HistorySummary = { count: rows.length, volume: 0, fees: 0, feesOther: {}, feeVolume: 0, feeRate: null, realized: 0, funding, net: 0 }
  for (const r of rows) {
    s.volume += r.volume ?? r.notional ?? 0
    s.fees += r.fees
    s.feeVolume += r.feeVolume
    for (const [a, v] of Object.entries(r.feesOther)) s.feesOther[a] = (s.feesOther[a] ?? 0) + v
    s.realized += r.realized ?? r.realizedPnl ?? 0
    s.funding += r.funding ?? 0
  }
  s.feeRate = feeRateOf(s.fees, s.feeVolume)
  s.net = s.realized - s.fees + s.funding
  return s
}
