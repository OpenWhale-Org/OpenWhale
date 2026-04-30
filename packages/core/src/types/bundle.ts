import type { Trigger } from './trigger.js'

export interface StrategyBundle {
  id: string
  name: string
  description?: string
  strategyCode: string
  executorCode?: string
  triggers: Trigger[]
  createdAt: string
  updatedAt: string
  enabled: boolean
}

export interface StrategyBundleInfo {
  id: string
  name: string
  description?: string
  enabled: boolean
  createdAt: string
  updatedAt: string
}
