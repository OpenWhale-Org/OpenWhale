import cron from 'node-cron'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'
import type { CronCondition, MonitorCondition, MonitorSource, Trigger, TriggerFilter } from '../types/trigger.js'
import type { IStrategy, StrategyContext } from '../types/strategy.js'
import type { CredentialStore } from '../types/credential.js'
import { TriggerState } from './TriggerState.js'

interface BundleEntry {
  triggers: Trigger[]
  strategy: IStrategy
}

export class TriggerManager {
  private readonly bundles = new Map<string, BundleEntry>()
  private readonly monitors = new Map<string, BaseMonitor>()
  private readonly cronTasks: cron.ScheduledTask[] = []
  private readonly triggerStates = new Map<string, TriggerState>()
  private running = false

  registerMonitor(monitor: BaseMonitor): void {
    this.monitors.set(monitor.monitorName, monitor)
  }

  registerBundle(bundleId: string, triggers: Trigger[], strategy: IStrategy): void {
    this.bundles.set(bundleId, { triggers, strategy })
  }

  unregisterBundle(bundleId: string): void {
    this.bundles.get(bundleId)?.triggers.forEach(t => this.triggerStates.delete(t.id))
    this.bundles.delete(bundleId)
  }

  start(queue: ExecutionQueue, credentialStore?: CredentialStore): void {
    if (this.running) return
    this.running = true
    this.injectDependencies(credentialStore)
    this.initTriggerStates()
    this.setupMonitorHandlers(queue)
    this.subscribeMonitors()
    this.scheduleCronConditions(queue)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.cronTasks.forEach(t => t.stop())
    this.cronTasks.length = 0
    this.unsubscribeMonitors()
  }

  // ── Start / stop helpers ──────────────────────────────────────────────────

  private injectDependencies(credentialStore?: CredentialStore): void {
    [...this.bundles.entries()].forEach(([bundleId, entry]) => {
      if (credentialStore) entry.strategy.setCredentialStore(credentialStore)
      entry.strategy.monitors.forEach(monitorName => {
        const monitor = this.monitors.get(monitorName)
        if (!monitor) throw new Error(
          `Bundle "${bundleId}": strategy "${entry.strategy.strategyId}" declares monitor dependency "${monitorName}" but it is not registered`
        )
        entry.strategy.setMonitorReader(monitorName, monitor.getReader())
      })
    })
  }

  private initTriggerStates(): void {
    [...this.bundles.values()].forEach(entry =>
      entry.triggers
        .filter(t => t.enabled)
        .forEach(t => this.triggerStates.set(t.id, new TriggerState(t.conditions.length)))
    )
  }

  private setupMonitorHandlers(queue: ExecutionQueue): void {
    [...this.monitors.entries()].forEach(([monitorName, monitor]) =>
      monitor.setEmitHandler((key, data) =>
        this.onMonitorEmit(monitorName, key, data as Record<string, unknown>, queue)
      )
    )
  }

  private async onMonitorEmit(
    monitorName: string,
    key: string,
    data: Record<string, unknown>,
    queue: ExecutionQueue,
  ): Promise<void> {
    const now = Date.now()
    await Promise.all(
      [...this.bundles.values()].flatMap(entry =>
        entry.triggers
          .filter(t => t.enabled)
          .map(async trigger => {
            const triggerState = this.triggerStates.get(trigger.id)
            if (!triggerState) return
            this.applyMonitorEmitToTrigger(trigger, triggerState, monitorName, key, data, now)
            return this.checkAndFire(trigger, triggerState, entry.strategy, queue, now)
          })
      )
    )
  }

  private applyMonitorEmitToTrigger(
    trigger: Trigger,
    triggerState: TriggerState,
    monitorName: string,
    key: string,
    data: Record<string, unknown>,
    now: number,
  ): void {
    trigger.conditions.forEach((condition, i) => {
      if (condition.type !== 'monitor') return
      condition.sources
        .filter(s => s.monitorName === monitorName)
        .filter(s => s.key === '*' || s.key === key)
        .filter(s => !s.filter || evaluateFilter(s.filter, data))
        .forEach(s => triggerState.satisfyMonitorSource(i, sourceKey(s, key), data, now))
    })
  }

  private subscribeMonitors(): void {
    [...this.bundles.values()].forEach(entry =>
      entry.triggers.filter(t => t.enabled).forEach(trigger =>
        trigger.conditions
          .filter((c): c is MonitorCondition => c.type === 'monitor')
          .flatMap(c => c.sources)
          .forEach(source => this.subscribeSource(source))
      )
    )
  }

  private unsubscribeMonitors(): void {
    [...this.bundles.values()].forEach(entry =>
      entry.triggers.forEach(trigger =>
        trigger.conditions
          .filter((c): c is MonitorCondition => c.type === 'monitor')
          .flatMap(c => c.sources)
          .forEach(source => this.unsubscribeSource(source))
      )
    )
  }

  private subscribeSource(source: MonitorSource): void {
    const monitor = this.monitors.get(source.monitorName)
    if (!monitor) return
    source.key === '*' ? monitor.subscribeAll() : monitor.subscribe(source.key as never)
  }

  private unsubscribeSource(source: MonitorSource): void {
    const monitor = this.monitors.get(source.monitorName)
    if (!monitor) return
    source.key === '*' ? monitor.unsubscribeAll() : monitor.unsubscribe(source.key as never)
  }

  private scheduleCronConditions(queue: ExecutionQueue): void {
    [...this.bundles.values()].forEach(entry =>
      entry.triggers.filter(t => t.enabled).forEach(trigger =>
        trigger.conditions.forEach((condition, i) => {
          if (condition.type === 'cron') this.scheduleCron(trigger, i, condition, entry.strategy, queue)
        })
      )
    )
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async checkAndFire(
    trigger: Trigger,
    triggerState: TriggerState,
    strategy: IStrategy,
    queue: ExecutionQueue,
    now: number,
  ): Promise<void> {
    if (!triggerState.isComplete(trigger.conditions, trigger.window, now)) return
    const monitorData = triggerState.collectMonitorData(trigger.conditions)
    triggerState.reset()
    const context: StrategyContext = { triggerId: trigger.id, monitorData, timestamp: now }
    const instructions = await strategy.run(context)
    await queue.pushBatch(instructions)
  }

  private scheduleCron(
    trigger: Trigger,
    conditionIndex: number,
    condition: CronCondition,
    strategy: IStrategy,
    queue: ExecutionQueue,
  ): void {
    const task = cron.schedule(condition.expression, async () => {
      const now = Date.now()
      const triggerState = this.triggerStates.get(trigger.id)
      if (!triggerState) return
      triggerState.satisfyCron(conditionIndex, now)
      await this.checkAndFire(trigger, triggerState, strategy, queue, now)
    })
    this.cronTasks.push(task)
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function sourceKey(source: MonitorSource, actualKey?: string): string {
  return `${source.monitorName}:${source.key === '*' ? actualKey ?? '*' : source.key}`
}

function evaluateFilter(filter: TriggerFilter, data: Record<string, unknown>): boolean {
  const value = data[filter.field]
  const threshold = filter.value
  switch (filter.op) {
    case 'gt':  return (value as number) > (threshold as number)
    case 'gte': return (value as number) >= (threshold as number)
    case 'lt':  return (value as number) < (threshold as number)
    case 'lte': return (value as number) <= (threshold as number)
    case 'eq':  return value === threshold
    case 'neq': return value !== threshold
  }
}
