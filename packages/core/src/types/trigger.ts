export interface TriggerFilter {
  field: string
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  value: unknown
}

export interface CronTrigger {
  type: 'cron'
  id: string
  expression: string
  strategyBundleId: string
  enabled: boolean
}

export interface SubscribeTrigger {
  type: 'subscribe'
  id: string
  monitorName: string
  key: string
  filter?: TriggerFilter
  strategyBundleId: string
  enabled: boolean
}

export type Trigger = CronTrigger | SubscribeTrigger
