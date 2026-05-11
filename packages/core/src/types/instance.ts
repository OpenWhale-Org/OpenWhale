import type { RawCredentialData } from './credential.js'

export interface StrategyParams {
  base: RawCredentialData
  tunable: RawCredentialData
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
