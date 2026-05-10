import type { ExecutionInstruction, ExecutionQueue } from '../../types/executor.js'
import type { IStrategy, StrategyContext, StrategyMetrics } from '../../types/strategy.js'
import type { MonitorDataReader } from '../../types/monitor.js'
import type { CredentialStore } from '../../types/credential.js'
import type { IStrategyStore } from '../../strategy/StrategyStore.js'
import type { HttpClient } from '../../strategy/HttpClient.js'
import { BaseMonitor, MonitorMode } from '../../monitor/BaseMonitor.js'

// ── MockQueue ─────────────────────────────────────────────────────────────────

export class MockQueue implements ExecutionQueue {
  readonly received: ExecutionInstruction[] = []

  async push(instruction: ExecutionInstruction): Promise<void> {
    this.received.push(instruction)
  }

  async pushBatch(instructions: ExecutionInstruction[]): Promise<void> {
    this.received.push(...instructions)
  }

  async consume(_executorId: string, _handler: (instruction: ExecutionInstruction) => Promise<void>): Promise<void> {}

  async stop(): Promise<void> {}
}

// ── MockStrategy ──────────────────────────────────────────────────────────────

export class MockStrategy implements IStrategy {
  readonly strategyId: string
  readonly monitors: readonly string[]
  readonly contexts: StrategyContext[] = []
  private instructions: ExecutionInstruction[]

  constructor(options: {
    id?: string
    monitors?: string[]
    instructions?: ExecutionInstruction[]
  } = {}) {
    this.strategyId = options.id ?? 'mock-strategy'
    this.monitors = options.monitors ?? []
    this.instructions = options.instructions ?? []
  }

  async run(context: StrategyContext): Promise<ExecutionInstruction[]> {
    this.contexts.push(context)
    return this.instructions
  }

  getMetrics(): StrategyMetrics {
    return { runsTotal: this.contexts.length, instructionsEmitted: 0, errors: 0 }
  }

  setMonitorReader(_key: string, _reader: MonitorDataReader): void {}
  setCredentialStore(_store: CredentialStore): void {}
  setStore(_store: IStrategyStore): void {}
  setHttpClient(_client: HttpClient): void {}
}

// ── MockMonitor ───────────────────────────────────────────────────────────────

export class MockMonitor extends BaseMonitor<string, Record<string, unknown>> {
  readonly mode = MonitorMode.Standalone
  readonly monitorName: string
  started = false

  constructor(name: string) {
    super()
    this.monitorName = name
  }

  protected startStandalone(): void { this.started = true }
  protected stopStandalone(): void { this.started = false }

  // Skip file I/O in tests
  protected async append(_key: string, _data: Record<string, unknown>): Promise<void> {}

  /** Manually push a data event for testing (persists + emits). */
  async fire(key: string, data: Record<string, unknown>): Promise<void> {
    await this.push(key, data)
  }

  /** Directly emit a data event for testing (skips persistence). */
  async emit(key: string, data: Record<string, unknown>): Promise<void> {
    await super.emit(key as never, data as never)
  }
}
