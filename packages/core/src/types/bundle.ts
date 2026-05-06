import type { Trigger } from './trigger.js'

export interface StrategyBundle {
  id: string
  name: string
  description?: string
  strategyId: string
  triggers: Trigger[]
  enabled: boolean
  createdAt: string
  updatedAt: string
}

// export interface StrategyBundleInfo {
//   id: string
//   name: string
//   description?: string
//   enabled: boolean
//   createdAt: string
//   updatedAt: string
// }
