export interface TriggerFilter {
  field: string
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  value: unknown
}

/** A single monitor subscription source within a MonitorCondition. Use key: '*' to match all keys. */
export interface MonitorSource {
  monitorName: string
  /** Specific monitor key, or '*' to match all keys emitted by this monitor. */
  key: string | '*'
  filter?: TriggerFilter
}

/**
 * Fires when a cron expression matches.
 * In a multi-condition Trigger, the cron acts as a "gate check":
 * when the cron fires, all other conditions are evaluated against their
 * cached state within the window.
 */
export interface CronCondition {
  type: 'cron'
  expression: string
}

/**
 * Fires when all sources have been satisfied within the Trigger's window.
 * Multiple sources within one MonitorCondition are AND-ed:
 * each source independently records its last-satisfied timestamp,
 * and all must fall within the window for the condition to be satisfied.
 */
export interface MonitorCondition {
  type: 'monitor'
  sources: [MonitorSource, ...MonitorSource[]]
}

export type TriggerCondition = CronCondition | MonitorCondition

/**
 * A Trigger fires when ALL of its conditions are satisfied within the window (AND).
 * Multiple Triggers on the same bundle are OR-ed: any one firing runs the Strategy.
 *
 * window semantics:
 * - Each condition independently tracks when it was last satisfied.
 * - On every new satisfaction event, stale condition states (older than window) are
 *   passively evicted, then all conditions are checked.
 * - If all conditions have been satisfied within the window, the Strategy runs
 *   and all condition states are reset.
 * - window = undefined means no expiry: satisfied states are kept until the
 *   Trigger fires or the process restarts.
 *
 * Examples:
 *   - Single MonitorCondition, no window → fires on every matching monitor push
 *   - Multiple MonitorConditions, window=60s → fires when all monitors satisfied within 60s
 *   - CronCondition + MonitorCondition, window=60s → fires each cron tick only if
 *     the monitor condition was also satisfied in the last 60s
 *
 * TODO: TriggerState is currently in-memory only. For multi-instance deployments,
 * consider persisting condition states to Redis so all instances share the same view.
 */
export interface Trigger {
  id: string
  strategyInstanceId: string
  enabled: boolean
  conditions: [TriggerCondition, ...TriggerCondition[]]
  window?: number  // ms; undefined = no expiry
}
