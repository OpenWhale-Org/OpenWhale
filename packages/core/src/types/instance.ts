import type { Trigger } from './trigger.js'

export interface StrategyInstance {
  id: string
  name: string
  description?: string
  strategyId: string
  triggers: Trigger[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}
