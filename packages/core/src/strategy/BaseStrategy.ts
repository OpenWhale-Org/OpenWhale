import type { ExecutionInstruction } from '../types/executor.js'
import type { IStrategy, StrategyContext, StrategyMetrics, StrategyOptions } from '../types/strategy.js'
import type { MonitorDataReader } from '../types/monitor.js'
import type { CredentialStore } from '../types/credential.js'
import { getDataDir } from '../utils/paths.js'
import { createLogger } from '../utils/logger.js'

export abstract class BaseStrategy implements IStrategy {
  abstract readonly strategyId: string

  protected readonly dataDir: string
  private readonly stepCache = new Map<string, unknown>()
  private readonly metrics: StrategyMetrics = {
    runsTotal: 0,
    instructionsEmitted: 0,
    errors: 0,
  }

  private monitorReaders = new Map<string, MonitorDataReader>()
  private credentialStore?: CredentialStore
  private get log() { return createLogger(this.strategyId) }

  constructor(options?: StrategyOptions) {
    this.dataDir = getDataDir(options?.dataDir)
  }

  setMonitorReader(key: string, reader: MonitorDataReader): void {
    this.monitorReaders.set(key, reader)
  }

  setCredentialStore(store: CredentialStore): void {
    this.credentialStore = store
  }

  async run(context: StrategyContext): Promise<ExecutionInstruction[]> {
    this.metrics.runsTotal++
    this.metrics.lastRunAt = Date.now()
    this.stepCache.clear()
    this.log.debug({ triggerId: context.triggerId }, 'Strategy run started')
    try {
      const instructions = await this.evaluate(context)
      this.metrics.instructionsEmitted += instructions.length
      this.log.debug({ triggerId: context.triggerId, instructionCount: instructions.length }, 'Strategy run completed')
      return instructions
    } catch (err) {
      this.metrics.errors++
      this.log.error({ triggerId: context.triggerId, err }, 'Strategy run failed')
      throw err
    }
  }

  abstract evaluate(context: StrategyContext): Promise<ExecutionInstruction[]>

  getMetrics(): StrategyMetrics {
    return { ...this.metrics }
  }

  protected rule(condition: boolean, instructions: ExecutionInstruction[]): ExecutionInstruction[] {
    return condition ? instructions : []
  }

  protected async step<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (this.stepCache.has(key)) return this.stepCache.get(key) as T
    const result = await fn()
    this.stepCache.set(key, result)
    return result
  }

  protected parallel(instructionSets: ExecutionInstruction[][]): ExecutionInstruction[] {
    return instructionSets.flat()
  }

  protected forEach<T>(
    items: T[],
    fn: (item: T) => ExecutionInstruction[]
  ): ExecutionInstruction[] {
    return items.flatMap(fn)
  }

  protected when(
    condition: boolean,
    thenInstructions: ExecutionInstruction[],
    elseInstructions: ExecutionInstruction[] = []
  ): ExecutionInstruction[] {
    return condition ? thenInstructions : elseInstructions
  }

  protected monitorData(key: string): MonitorDataReader | undefined {
    return this.monitorReaders.get(key)
  }

  protected async credential(name: string): Promise<string> {
    if (!this.credentialStore) throw new Error('CredentialStore not configured')
    return this.credentialStore.getByName(name)
  }

  protected llm(_prompt: string): never {
    throw new Error('llm() is not available in Phase 1 — use the Compiler to generate strategies with LLM calls')
  }
}

