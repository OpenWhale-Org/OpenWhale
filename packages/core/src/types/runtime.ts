import type { StrategyBundle } from './bundle.js'
import type { ExecutionQueue } from './executor.js'

export interface RuntimeOptions {
  dataDir?: string
  queue?: ExecutionQueue
}

export interface IRuntime {
  activate(bundle: StrategyBundle): Promise<void>
  deactivate(bundleId: string): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  listBundles(): StrategyBundle[]
}
