import type { RawCredentialData } from './credential.js'
import type { LlmSlotBinding } from './strategy.js'

export interface StrategyParams {
  base: RawCredentialData
  tunable: RawCredentialData
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
