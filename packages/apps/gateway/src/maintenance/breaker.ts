import { getLogger } from '@openwhaleorg/core'
import type { SQLiteAdapter, OpenWhaleRuntime, BreakerRule, PnlWindow, LedgerHealth } from '@openwhaleorg/core'
import { getAlertService } from '../notify/alerts.js'

const log = getLogger().child({ module: 'Breaker' })

/**
 * Circuit breakers on an instance's own ledger.
 *
 * This is the alerting feature grown a second verb. Alerts fire on what an
 * instance DID — an execution failed, an action was taken. A breaker fires on
 * what happened AFTERWARDS: the fills landed, the funding settled, and the
 * number came out wrong. That is a different clock and a different source, so
 * it is a different service, but the delivery is the same one.
 *
 * The one rule that shapes everything else: a breaker that cannot see does
 * nothing. A stopped collector and a stopped strategy produce the same
 * reading — flat PnL, no fills — and acting on that would deactivate healthy
 * instances precisely when the observability is broken. So every pass asks
 * `ledgerHealth` first and abstains unless the answer is yes.
 */

const EVAL_INTERVAL_MS = 60_000
const HISTORY_CAP = 500
const DEFAULT_COOLDOWN_MIN = 60
const DEFAULT_MIN_SAMPLES = 10

export interface BreakerTrip {
  id: number
  instanceId: string
  instanceName: string
  ruleId: string
  label: string
  metric: BreakerRule['metric']
  windowMin: number
  threshold: number
  /** The measure as read at trip time. */
  observed: number
  action: BreakerRule['action']
  /** True when the action was actually carried out (deactivate can fail). */
  applied: boolean
  at: string
  detail: string
}

/** Why a pass did nothing — surfaced so a silent breaker is never a mystery. */
export interface BreakerStatus {
  instanceId: string
  enabled: boolean
  rules: number
  ledger: LedgerHealth
  /** Null while the ledger is not live. */
  windows?: Array<{ ruleId: string; windowMin: number; metric: string; observed: number | null; threshold: number; tripped: boolean }>
}

interface Row { [k: string]: unknown }

function ruleLabel(r: BreakerRule): string {
  if (r.label) return r.label
  return r.metric === 'netPnl'
    ? `net PnL below ${r.below} over ${r.windowMin}m`
    : `win rate below ${r.below}% over ${r.windowMin}m`
}

export class BreakerService {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false
  /** `${instanceId}:${ruleId}` → epoch ms of the last alert for that rule. */
  private readonly lastAlert = new Map<string, number>()

  constructor(
    private readonly db: SQLiteAdapter,
    private readonly runtime: OpenWhaleRuntime,
  ) {}

  async initialize(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS breaker_trips (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id   TEXT NOT NULL,
        instance_name TEXT NOT NULL,
        rule_id       TEXT NOT NULL,
        label         TEXT NOT NULL,
        metric        TEXT NOT NULL,
        window_min    REAL NOT NULL,
        threshold     REAL NOT NULL,
        observed      REAL NOT NULL,
        action        TEXT NOT NULL,
        applied       INTEGER NOT NULL,
        at            TEXT NOT NULL,
        detail        TEXT NOT NULL
      )
    `)
    await this.db.run('CREATE INDEX IF NOT EXISTS idx_breaker_trips_at ON breaker_trips (at DESC)')
    // A minute is far finer than the ledger moves (ten), which is deliberate:
    // the cost of a pass is two indexed queries per armed instance, and the
    // moment a collection lands the breaker should act on it rather than wait
    // out the rest of a coarse tick.
    this.timer = setInterval(() => { void this.sweep() }, EVAL_INTERVAL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  // ── evaluation ────────────────────────────────────────────────────────────

  private armed(): Array<{ id: string; name: string; rules: BreakerRule[] }> {
    // listInstances() is the LIVE map, so membership already means "running".
    // A deactivated instance leaves it, which is also how a tripped breaker
    // stops re-tripping on the instance it just stopped.
    return this.runtime.listInstances()
      .filter(i => i.options?.breakerEnabled && (i.options.breaker?.length ?? 0) > 0)
      .map(i => ({ id: i.id, name: i.name, rules: i.options!.breaker! }))
  }

  /** What one rule reads right now, or null when the window cannot answer. */
  private measure(rule: BreakerRule, w: PnlWindow): number | null {
    if (rule.metric === 'netPnl') return w.net
    const min = rule.minSamples ?? DEFAULT_MIN_SAMPLES
    // Two closes at 0% is noise, not a losing streak.
    if (w.closingFills < min) return null
    return w.winRatePct
  }

  /** Read-only: what the breaker sees for one instance, without acting. */
  async status(instanceId: string): Promise<BreakerStatus> {
    const inst = this.runtime.listInstances().find(i => i.id === instanceId)
    const rules = inst?.options?.breaker ?? []
    const enabled = Boolean(inst?.options?.breakerEnabled) && rules.length > 0
    const pnl = this.runtime.pnl
    if (!pnl) {
      return { instanceId, enabled, rules: rules.length,
        ledger: { live: false, oldestMarkTs: null, pairs: 0, stalePairs: 0, reason: 'PnL service is not running' } }
    }
    const ledger = await pnl.ledgerHealth(instanceId)
    if (!ledger.live) return { instanceId, enabled, rules: rules.length, ledger }

    const windows = []
    for (const rule of rules) {
      const w = await pnl.instanceWindow(instanceId, Date.now() - rule.windowMin * 60_000)
      const observed = this.measure(rule, w)
      windows.push({
        ruleId: rule.id, windowMin: rule.windowMin, metric: rule.metric,
        observed, threshold: rule.below, tripped: observed !== null && observed < rule.below,
      })
    }
    return { instanceId, enabled, rules: rules.length, ledger, windows }
  }

  /** One instance's pass. Returns the trips it recorded. */
  async evaluate(instanceId: string): Promise<BreakerTrip[]> {
    const inst = this.runtime.listInstances().find(i => i.id === instanceId)
    if (!inst?.options?.breakerEnabled) return []
    const rules = inst.options.breaker ?? []
    if (rules.length === 0) return []
    const pnl = this.runtime.pnl
    if (!pnl) return []

    const ledger = await pnl.ledgerHealth(instanceId)
    if (!ledger.live) {
      log.debug({ instanceId, reason: ledger.reason }, 'Breaker abstains — ledger is not live')
      return []
    }

    const trips: BreakerTrip[] = []
    let deactivate: { rule: BreakerRule; observed: number } | null = null

    for (const rule of rules) {
      const w = await pnl.instanceWindow(instanceId, Date.now() - rule.windowMin * 60_000)
      const observed = this.measure(rule, w)
      if (observed === null || observed >= rule.below) continue

      if (rule.action === 'deactivate') {
        // Strongest wins, and only one deactivation happens per pass however
        // many rules agree about it.
        if (!deactivate || rule.below > deactivate.rule.below) deactivate = { rule, observed }
        continue
      }

      const key = `${instanceId}:${rule.id}`
      const cooldownMs = (rule.cooldownMin ?? DEFAULT_COOLDOWN_MIN) * 60_000
      if (Date.now() - (this.lastAlert.get(key) ?? 0) < cooldownMs) continue
      this.lastAlert.set(key, Date.now())
      trips.push(await this.fire(inst.id, inst.name, rule, observed, w, true))
    }

    if (deactivate) {
      let applied = true
      try {
        await this.runtime.deactivate(instanceId)
      } catch (err) {
        applied = false
        log.error({ instanceId, err }, 'Breaker could not deactivate the instance')
      }
      const w = await pnl.instanceWindow(instanceId, Date.now() - deactivate.rule.windowMin * 60_000)
      trips.push(await this.fire(inst.id, inst.name, deactivate.rule, deactivate.observed, w, applied))
    }
    return trips
  }

  /** Record the trip, then say so. */
  private async fire(
    instanceId: string, instanceName: string, rule: BreakerRule,
    observed: number, w: PnlWindow, applied: boolean,
  ): Promise<BreakerTrip> {
    const label = ruleLabel(rule)
    const unit = rule.metric === 'netPnl' ? '' : '%'
    const detail =
      `window ${rule.windowMin}m · net ${w.net.toFixed(2)} ` +
      `(realized ${w.realized.toFixed(2)}, fees ${w.fees.toFixed(2)}, funding ${w.funding.toFixed(2)}) · ` +
      `${w.fills} fills, ${w.closingFills} closing, ${w.wins} wins`
    const at = new Date().toISOString()

    await this.db.run(
      `INSERT INTO breaker_trips
         (instance_id, instance_name, rule_id, label, metric, window_min, threshold, observed, action, applied, at, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [instanceId, instanceName, rule.id, label, rule.metric, rule.windowMin,
        rule.below, observed, rule.action, applied ? 1 : 0, at, detail])
    await this.db.run(
      `DELETE FROM breaker_trips WHERE id NOT IN (SELECT id FROM breaker_trips ORDER BY id DESC LIMIT ?)`,
      [HISTORY_CAP])

    const verb = rule.action === 'deactivate'
      ? (applied ? 'STOPPED' : 'COULD NOT STOP')
      : 'alert'
    const subject = `[OpenWhale] breaker ${verb}: ${instanceName}`
    const text = [
      `Instance : ${instanceName} (${instanceId})`,
      `Rule     : ${label}`,
      `Observed : ${observed.toFixed(2)}${unit}  (threshold ${rule.below}${unit})`,
      `Ledger   : ${detail}`,
      rule.action === 'deactivate'
        ? applied
          ? 'The instance has been deactivated. Any open position is whatever its onDeactivate hook left behind — check it.'
          : 'DEACTIVATION FAILED — the instance may still be trading. Stop it by hand.'
        : 'No action taken; this rule only alerts.',
    ].join('\n')

    const alerts = getAlertService()
    if (alerts) {
      const { failed } = await alerts.dispatch(subject, text)
      if (failed.length > 0) log.warn({ instanceId, failed }, 'Breaker alert partially undelivered')
    } else {
      log.warn({ instanceId, subject }, 'Breaker tripped but no alert service is configured')
    }
    log.warn({ instanceId, rule: rule.id, observed, threshold: rule.below, action: rule.action, applied }, 'Breaker tripped')

    return {
      id: 0, instanceId, instanceName, ruleId: rule.id, label, metric: rule.metric,
      windowMin: rule.windowMin, threshold: rule.below, observed, action: rule.action, applied, at, detail,
    }
  }

  /** Every armed instance, one after another. */
  async sweep(): Promise<BreakerTrip[]> {
    if (this.running) return []
    this.running = true
    try {
      const out: BreakerTrip[] = []
      for (const inst of this.armed()) {
        try {
          out.push(...await this.evaluate(inst.id))
        } catch (err) {
          log.error({ instanceId: inst.id, err }, 'Breaker evaluation failed')
        }
      }
      return out
    } finally {
      this.running = false
    }
  }

  /** Newest first. */
  async trips(limit = 100): Promise<BreakerTrip[]> {
    const rows = await this.db.all<Row>(
      'SELECT * FROM breaker_trips ORDER BY id DESC LIMIT ?',
      [Math.min(Math.max(limit, 1), HISTORY_CAP)])
    return rows.map(r => ({
      id: Number(r.id),
      instanceId: String(r.instance_id),
      instanceName: String(r.instance_name),
      ruleId: String(r.rule_id),
      label: String(r.label),
      metric: r.metric === 'winRate' ? 'winRate' : 'netPnl',
      windowMin: Number(r.window_min),
      threshold: Number(r.threshold),
      observed: Number(r.observed),
      action: r.action === 'deactivate' ? 'deactivate' : 'alert',
      applied: Number(r.applied) === 1,
      at: String(r.at),
      detail: String(r.detail),
    }))
  }
}

let service: BreakerService | undefined
export function setBreakerService(s: BreakerService): void { service = s }
export function getBreakerService(): BreakerService | undefined { return service }
