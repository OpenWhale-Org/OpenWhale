import { getLogger } from '@openwhaleorg/core'
import { onVenueMinute, type VenueMinute } from '@openwhaleorg/ccxt-adapter'
import { getAlertService } from './alerts.js'

const log = () => getLogger().child({ module: 'BudgetWatch' })

/**
 * Tell someone BEFORE a venue starts answering 429, not after.
 *
 * The request meter closes a minute for every venue with what was spent and on
 * what. This compares that against the budget the venue publishes and raises
 * an alert through the same channels execution failures use. The number that
 * matters is the ratio: Hyperliquid at 1000 of 1200 is one bad tick from
 * failing every order's preflight read, and nothing else in the engine says so
 * until the failures arrive — by which time the useful minute has passed.
 *
 * Budgets are per IP per minute, in the venue's own weight units — the same
 * units ccxt's cost table (and so the meter) already speaks.
 */

/** Weight a minute, per IP, as each venue publishes it. */
const PUBLISHED_BUDGET: Record<string, number> = {
  hyperliquid: 1200,   // docs: aggregated 1200/min per IP
  aster: 2400,         // /fapi/v1/exchangeInfo → REQUEST_WEIGHT 2400/MINUTE
  binanceusdm: 2400,   // fapi REQUEST_WEIGHT 2400/MINUTE
  binancecoinm: 2400,
  binance: 6000,       // spot
}

/** Fraction of the budget at which to say something. */
const DEFAULT_ALERT_PCT = 0.7
/** Below this the venue is considered calm again, and a recovery is reported once. */
const CALM_PCT = 0.5
/** A venue that stays hot is re-reported this often, not every minute. */
const REPEAT_MS = 15 * 60_000

function budgetFor(venue: string): number | undefined {
  const suffix = venue.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const override = Number(process.env[`OPENWHALE_VENUE_BUDGET_${suffix}`])
  if (Number.isFinite(override) && override > 0) return override
  return PUBLISHED_BUDGET[venue]
}

function alertPct(): number {
  const raw = Number(process.env['OPENWHALE_BUDGET_ALERT_PCT'])
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : DEFAULT_ALERT_PCT
}

interface VenueState { lastAlertAt: number; hot: boolean }

export class BudgetWatch {
  private readonly state = new Map<string, VenueState>()
  private unsubscribe: (() => void) | null = null

  start(): void {
    this.unsubscribe?.()
    this.unsubscribe = onVenueMinute((minute) => { void this.consider(minute) })
    log().info({ budgets: PUBLISHED_BUDGET, alertAt: alertPct() }, 'Venue budget watch armed')
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async consider(minute: VenueMinute): Promise<void> {
    try {
      const budget = budgetFor(minute.venue)
      if (budget === undefined) return
      const ratio = minute.weight / budget
      const state = this.state.get(minute.venue) ?? { lastAlertAt: 0, hot: false }
      const now = Date.now()

      if (ratio >= alertPct()) {
        const due = !state.hot || now - state.lastAlertAt >= REPEAT_MS
        state.hot = true
        if (due) {
          state.lastAlertAt = now
          await this.send(
            `OpenWhale: ${minute.venue} at ${Math.round(ratio * 100)}% of its request budget`,
            [
              `Venue:     ${minute.venue}`,
              `Minute:    ${new Date(now).toISOString()}`,
              `Spent:     ${minute.weight} of ${budget} weight (${Math.round(ratio * 100)}%)`,
              `Calls:     ${minute.calls}`,
              '',
              'Heaviest endpoints this minute:',
              ...minute.top.map(t => `  ${t}`),
              '',
              'Above this line the venue starts answering 429, and every execution',
              'whose preflight read draws one fails. Find the spender in the list.',
            ].join('\n'),
          )
        }
      } else if (state.hot && ratio < CALM_PCT) {
        state.hot = false
        await this.send(
          `OpenWhale: ${minute.venue} back to ${Math.round(ratio * 100)}% of its request budget`,
          `Venue:     ${minute.venue}\nSpent:     ${minute.weight} of ${budget} weight this minute.`,
        )
      }
      this.state.set(minute.venue, state)
    } catch (err) {
      log().warn({ err }, 'Budget watch failed — ignored')
    }
  }

  /** Through the alert channels when they are on; the log carries it regardless. */
  private async send(subject: string, text: string): Promise<void> {
    log().warn({ subject }, text)
    const alerts = getAlertService()
    if (!alerts || !alerts.current().enabled) return
    await alerts.dispatch(subject, text)
  }
}
