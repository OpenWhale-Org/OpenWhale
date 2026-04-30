import type { ExecutionInstruction } from './executor.js'

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
}
