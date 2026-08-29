import type { RawCredentialData } from './credential.js'
import type { LlmSlotBinding } from './strategy.js'

export interface StrategyParams {
  base: RawCredentialData
  tunable: RawCredentialData
}

/**
 * Per-instance switches that belong to the FRAMEWORK rather than to any
 * strategy's own params.
 *
 * A strategy may declare a `dryRun` param of its own, and several do — but
 * that one is the strategy asking its executor to take the simulate branch,
 * which still reaches the venue for prices and margin. This one is the engine
 * declining to queue the instruction at all. Two different questions, so two
 * different switches; this is the one an operator can trust without reading
 * the strategy's source.
 */
export interface InstanceOptions {
  /** Alert when an execution of this instance fails. Absent = on. */
  alertOnFailure?: boolean
  /**
   * Alert on every execution whose action is named here — the successful ones
   * too. Absent or empty = off, because a strategy that acts every minute
   * would otherwise mail every minute.
   */
  alertOnActions?: string[]
  /**
   * Hold every instruction this instance emits, recording it and queueing
   * none. Absent = off: a switch that silently stops trading must be the
   * thing you turned on, never the default you inherited.
   */
  dryRun?: boolean
}

export interface StrategyInstance {
  id: string
  name: string
  description?: string
  strategyId: string
  /** Positional credential binding for strategy account slots (legacy style). */
  accounts?: string[]
  /**
   * Named credential bindings: strategy slots by label, executor slots by
   * 'executorLabel:slotLabel'. Takes precedence over the positional array.
   */
  credentials?: Record<string, string>   // Credential name list, ordered by strategy.accountTypes
  /** Per-label LLM slot overrides: { [llmLabel]: { model?, credentialName?, settings? } } */
  llm?: Record<string, LlmSlotBinding>
  params?: StrategyParams
  /** Framework-level switches: alerting, dry run. */
  options?: InstanceOptions
  enabled: boolean
  /** Emoji shown on cards/boards. Assigned at creation (random) when absent. */
  icon?: string
  /** Grouping folder on the instances page; undefined = ungrouped. */
  folder?: string
  /** Manual ordering inside a folder (ascending). */
  sortOrder?: number
  createdAt: string
  updatedAt: string
}

/** Persisted instance + live activation state, as dashboards see it. */
export type StrategyInstanceView = StrategyInstance & {
  active: boolean
  /**
   * Set when the instance names a strategy no longer in the registry — its
   * plugin was uninstalled, or replaced by a version that dropped it.
   *
   * The row is deliberately kept rather than cleaned up: it still holds the
   * params someone tuned and the accounts they bound, and reinstalling the
   * plugin makes it whole again. Reported so the instance reads as broken
   * instead of merely stopped, which is the difference between "I turned this
   * off" and "the code this ran on is gone".
   */
  problem?: string
}
