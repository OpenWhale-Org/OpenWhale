export interface StrategyParams {
  base: Record<string, unknown>
  tunable: Record<string, unknown>
}

export interface StrategyInstance {
  id: string
  name: string
  description?: string
  strategyId: string
  accounts?: string[]   // Credential name list, ordered by strategy.accountTypes
  params?: StrategyParams
  enabled: boolean
  createdAt: string
  updatedAt: string
}
