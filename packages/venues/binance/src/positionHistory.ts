import type { ExchangeFill, FundingEvent } from '@openwhaleorg/exchange'

/**
 * Binance's "Position History" tab, rebuilt from the account's own fills.
 *
 * The venue offers no endpoint for it on USDⓈ-M; the web page derives it from
 * trades, and so does this: a position opens when the net quantity leaves
 * zero and closes when it returns, and everything in between is one episode.
 * In hedge mode LONG and SHORT are separate books on the same contract; in
 * one-way mode a fill that overshoots the net flips the book — the overshoot
 * opens the next episode at the same price.
 *
 * Realized PnL is what the venue reported on each closing fill (position PnL
 * only). Fees and funding are kept apart so the net is visible rather than
 * assumed, and because fees may be paid in BNB.
 */

export type PositionSide = 'LONG' | 'SHORT' | 'BOTH'

export interface Episode {
  symbol: string
  positionSide: PositionSide
  direction: 'long' | 'short'
  /** First fill of the episode — or the first fill SEEN, when it opened before the range. */
  openedAt: number
  /** Last closing fill; absent while the position is still open. */
  closedAt?: number
  status: 'closed' | 'open'
  /** Opened before the range began: the opening fills are not in hand. */
  truncated: boolean
  /** Quantity opened within the range (sum of opening fills). */
  openedQty: number
  /** Quantity closed within the range (sum of closing fills). */
  closedQty: number
  /** Largest net quantity held during the episode. */
  maxQty: number
  /** Net quantity still held (open episodes). */
  remainingQty: number
  /** Quantity-weighted average of the opening fills. */
  openAvg: number
  /** Quantity-weighted average of the closing fills. */
  closeAvg: number
  /** Venue-reported realized position PnL across the episode's fills. */
  tradePnl: number
  /** Quote traded across the episode's fills, opening and closing both. */
  volume: number
  /** Fees by asset, as positive costs. */
  fees: Record<string, number>
  /** Funding payments attributed to the episode (positive = received). */
  funding: number
  fillCount: number
  /** Fill ids, in order, for the fills tab to link back. */
  fillIds: string[]
}

export interface ReplayResult {
  closed: Episode[]
  open: Episode[]
}

const EPS = 1e-9

interface Book {
  episode: Episode
  net: number
  openNotional: number
  closeNotional: number
}

function newEpisode(f: ExchangeFill, side: PositionSide, direction: 'long' | 'short', truncated: boolean): Episode {
  return {
    symbol: f.symbol, positionSide: side, direction,
    openedAt: f.timestamp, status: 'open', truncated,
    openedQty: 0, closedQty: 0, maxQty: 0, remainingQty: 0,
    openAvg: 0, closeAvg: 0, tradePnl: 0, volume: 0, fees: {}, funding: 0,
    fillCount: 0, fillIds: [],
  }
}

function addFee(e: Episode, f: ExchangeFill, share: number): void {
  if (f.fee === undefined || !Number.isFinite(f.fee) || f.fee === 0) return
  const asset = f.feeAsset ?? 'USDT'
  e.fees[asset] = (e.fees[asset] ?? 0) + f.fee * share
}

function positionSideOf(f: ExchangeFill, hedged: boolean): PositionSide {
  if (!hedged) return 'BOTH'
  const raw = String(f.info?.['positionSide'] ?? '').toUpperCase()
  return raw === 'LONG' || raw === 'SHORT' ? raw : 'BOTH'
}

/**
 * Replay fills, oldest first, into position episodes.
 *
 * `hedged` decides whether LONG and SHORT on one contract are separate books.
 * Fills must cover the whole range contiguously; what opened before the range
 * is recognised by its first fill being a close (venue-reported PnL on it, or
 * a hedge-mode fill on the closing side) and flagged `truncated`.
 */
export function replayFills(fills: ExchangeFill[], hedged: boolean): ReplayResult {
  const books = new Map<string, Book>()
  const closed: Episode[] = []
  const sorted = [...fills].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))

  for (const f of sorted) {
    if (!(f.qty > 0)) continue
    const side = positionSideOf(f, hedged)
    const key = `${f.symbol}|${side}`
    const signed = f.side === 'buy' ? f.qty : -f.qty
    let book = books.get(key)

    if (!book) {
      // Nothing held: this fill either opens a book or closes one we never saw.
      const closesUnseen = side === 'LONG' ? f.side === 'sell'
        : side === 'SHORT' ? f.side === 'buy'
        : Math.abs(f.realizedPnl ?? 0) > EPS
      const direction: 'long' | 'short' = closesUnseen ? (signed > 0 ? 'short' : 'long') : (signed > 0 ? 'long' : 'short')
      book = { episode: newEpisode(f, side, direction, closesUnseen), net: 0, openNotional: 0, closeNotional: 0 }
      books.set(key, book)
      if (closesUnseen) {
        // Record the close against an opening we cannot see; the book stays at
        // zero rather than going negative, and the episode closes at once.
        const e = book.episode
        e.closedQty += f.qty
        book.closeNotional += f.qty * f.price
        e.closeAvg = book.closeNotional / e.closedQty
        e.tradePnl += f.realizedPnl ?? 0
        e.volume += f.qty * f.price
        addFee(e, f, 1)
        e.fillCount++
        e.fillIds.push(f.id)
        e.closedAt = f.timestamp
        e.status = 'closed'
        closed.push(e)
        books.delete(key)
        continue
      }
    }

    const e = book.episode
    const opening = book.net === 0 ? true : Math.sign(signed) === Math.sign(book.net)
    if (opening) {
      book.net += signed
      e.openedQty += f.qty
      book.openNotional += f.qty * f.price
      e.openAvg = book.openNotional / e.openedQty
      e.volume += f.qty * f.price
      addFee(e, f, 1)
      e.fillCount++
      e.fillIds.push(f.id)
      e.maxQty = Math.max(e.maxQty, Math.abs(book.net))
      e.remainingQty = Math.abs(book.net)
      continue
    }

    // Closing: up to what is held; any overshoot flips the book.
    const held = Math.abs(book.net)
    const closeQty = Math.min(f.qty, held)
    const overshoot = f.qty - closeQty
    const closeShare = closeQty / f.qty
    e.closedQty += closeQty
    book.closeNotional += closeQty * f.price
    e.closeAvg = book.closeNotional / e.closedQty
    e.tradePnl += f.realizedPnl ?? 0
    e.volume += closeQty * f.price
    addFee(e, f, overshoot > EPS ? closeShare : 1)
    e.fillCount++
    e.fillIds.push(f.id)
    book.net += Math.sign(signed) * closeQty
    e.remainingQty = Math.abs(book.net)
    if (Math.abs(book.net) < EPS) {
      book.net = 0
      e.remainingQty = 0
      e.closedAt = f.timestamp
      e.status = 'closed'
      closed.push(e)
      books.delete(key)
    }
    if (overshoot > EPS) {
      const direction: 'long' | 'short' = signed > 0 ? 'long' : 'short'
      const next: Book = { episode: newEpisode(f, side, direction, false), net: Math.sign(signed) * overshoot, openNotional: overshoot * f.price, closeNotional: 0 }
      next.episode.openedQty = overshoot
      next.episode.openAvg = f.price
      next.episode.maxQty = overshoot
      next.episode.remainingQty = overshoot
      next.episode.volume = overshoot * f.price
      addFee(next.episode, f, 1 - closeShare)
      next.episode.fillCount++
      next.episode.fillIds.push(f.id)
      books.set(key, next)
    }
  }

  const open = [...books.values()].map(b => b.episode)
  return { closed, open }
}

/**
 * Attach funding payments to the episode that held the contract at the time.
 *
 * Funding rows carry a symbol and a time, not a side. When both sides of a
 * hedged contract were open at once the payment goes to the larger book —
 * the venue charges each side on its own notional, but the ledger does not
 * say which row is which. Payments that match no episode are returned so the
 * caller can show them rather than lose them.
 */
export function attributeFunding(result: ReplayResult, funding: FundingEvent[]): FundingEvent[] {
  const all = [...result.closed, ...result.open]
  const bySymbol = new Map<string, Episode[]>()
  for (const e of all) {
    const rows = bySymbol.get(e.symbol) ?? []
    rows.push(e)
    bySymbol.set(e.symbol, rows)
  }
  const orphans: FundingEvent[] = []
  for (const ev of funding) {
    const candidates = (bySymbol.get(ev.symbol) ?? []).filter(e =>
      ev.timestamp >= e.openedAt && (e.closedAt === undefined || ev.timestamp <= e.closedAt))
    if (candidates.length === 0) { orphans.push(ev); continue }
    const target = candidates.reduce((a, b) => (b.maxQty > a.maxQty ? b : a))
    target.funding += ev.amount
  }
  return orphans
}

/** Fees paid in the quote asset, as a positive number. */
export function quoteFees(e: Episode, quote: string): number {
  return e.fees[quote] ?? 0
}

/**
 * Binance's "ROI" on the position-history tab: realized PnL over the initial
 * margin of the largest exposure, i.e. notional at the opening average
 * divided by leverage. Without a leverage the return is on notional.
 */
export function returnPct(e: Episode, leverage: number | undefined): number | undefined {
  const notional = e.openAvg * e.maxQty
  if (!(notional > 0)) return undefined
  return (e.tradePnl / notional) * (leverage && leverage > 0 ? leverage : 1) * 100
}
