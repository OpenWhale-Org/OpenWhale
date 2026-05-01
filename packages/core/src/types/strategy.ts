import type { ExecutionInstruction } from './executor.js'
import type { MonitorDataReader } from './monitor.js'
import type { CredentialStore } from './credential.js'

export interface StrategyContext {
  triggerType: 'cron' | 'subscribe'
  triggerId: string
  monitorKey?: string
  monitorData?: Record<string, unknown>
  timestamp: number
}

export interface StrategyMetrics {
  runsTotal: number
  instructionsEmitted: number
  lastRunAt?: number
  errors: number
}

export interface StrategyOptions {
  dataDir?: string
}

export interface IStrategy {
  readonly strategyId: string
  run(context: StrategyContext): Promise<ExecutionInstruction[]>
  getMetrics(): StrategyMetrics
  setMonitorReader(key: string, reader: MonitorDataReader): void
  setCredentialStore(store: CredentialStore): void
}
