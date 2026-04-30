import type { StrategyBundle } from '../types/bundle.js'
import type { ExecutionQueue, ExecutorOptions } from '../types/executor.js'
import type { IRuntime, RuntimeOptions } from '../types/runtime.js'
import type { IStrategy } from '../types/strategy.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import { MemoryExecutionQueue } from '../executor/MemoryExecutionQueue.js'
import { TriggerManager } from '../trigger/TriggerManager.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import { getDataDir } from '../utils/paths.js'

export class OpenWhaleRuntime implements IRuntime {
  private readonly bundles = new Map<string, StrategyBundle>()
  private readonly strategies = new Map<string, IStrategy>()
  private readonly executors: BaseExecutor[] = []
  private readonly triggerManager = new TriggerManager()
  private readonly queue: ExecutionQueue
  protected readonly dataDir: string
  private running = false

  constructor(options?: RuntimeOptions) {
    this.dataDir = getDataDir(options?.dataDir)
    this.queue = options?.queue ?? new MemoryExecutionQueue()
  }

  registerMonitor(monitor: BaseMonitor): void {
    this.triggerManager.registerMonitor(monitor)
  }

  registerExecutor(executor: BaseExecutor): void {
    this.executors.push(executor)
  }

  registerStrategy(strategy: IStrategy): void {
    this.strategies.set(strategy.strategyId, strategy)
  }

  async activate(bundle: StrategyBundle): Promise<void> {
    this.bundles.set(bundle.id, bundle)
    const strategy = this.strategies.get(bundle.id)
    if (strategy) {
      this.triggerManager.registerBundle(bundle.id, bundle.triggers, strategy)
    }
  }

  async deactivate(bundleId: string): Promise<void> {
    this.bundles.delete(bundleId)
    this.triggerManager.unregisterBundle(bundleId)
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true

    this.triggerManager.start(this.queue)

    for (const executor of this.executors) {
      void executor.run(this.queue)
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.triggerManager.stop()
    await this.queue.stop()
  }

  listBundles(): StrategyBundle[] {
    return Array.from(this.bundles.values())
  }
}
