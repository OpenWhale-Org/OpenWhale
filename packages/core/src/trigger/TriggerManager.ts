import cron from 'node-cron'
import { MonitorMode, type BaseMonitor } from '../monitor/BaseMonitor.js'
import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'
import type { CronCondition, MonitorCondition, MonitorSource, Trigger, TriggerFilter } from '../types/trigger.js'
import type { IStrategy, StrategyContext } from '../types/strategy.js'
import type { CredentialStore } from '../types/credential.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import type { StrategyParams } from '../types/instance.js'
import type { IAccount } from '../types/account.js'
import { DBStrategyStore } from '../strategy/StrategyStore.js'
import { HttpClient } from '../strategy/HttpClient.js'
import { TriggerState } from './TriggerState.js'

interface InstanceEntry {
  instanceId: string
  triggers: Trigger[]
  strategy: IStrategy
}

export class TriggerManager {
  private readonly instances = new Map<string, InstanceEntry>()
  private readonly monitors = new Map<string, BaseMonitor>()
  private readonly cronTasks: cron.ScheduledTask[] = []
  private readonly triggerStates = new Map<string, TriggerState>()
  private running = false

  registerMonitor(monitor: BaseMonitor): void {
    this.monitors.set(monitor.monitorName, monitor)
  }

  registerInstance(
    instanceId: string,
    strategy: IStrategy,
    triggers: Trigger[],
    params: StrategyParams,
    accounts: IAccount[],
  ): void {
    strategy.setParams(params)
    strategy.setAccounts(accounts)
    this.instances.set(instanceId, { instanceId, triggers, strategy })
  }

  unregisterInstance(instanceId: string): void {
    this.instances.get(instanceId)?.triggers.forEach(t => this.triggerStates.delete(t.id))
    this.instances.delete(instanceId)
  }

  /** @deprecated Use registerInstance */
  registerBundle(instanceId: string, triggers: Trigger[], strategy: IStrategy): void {
    strategy.setParams({ base: {}, tunable: {} })
    strategy.setAccounts([])
    this.instances.set(instanceId, { instanceId, triggers, strategy })
  }

  /** @deprecated Use unregisterInstance */
  unregisterBundle(instanceId: string): void {
    this.unregisterInstance(instanceId)
  }

  start(queue: ExecutionQueue, credentialStore?: CredentialStore, database?: DatabaseAdapter): void {
    if (this.running) return
    this.running = true
    this.injectDependencies(credentialStore, database)
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

  private injectDependencies(credentialStore?: CredentialStore, database?: DatabaseAdapter): void {
    for (const { instanceId, strategy } of this.instances.values()) {
      if (credentialStore) strategy.setCredentialStore(credentialStore)

      if (database) {
        strategy.setStore(new DBStrategyStore(instanceId, database))
      }

      strategy.setHttpClient(new HttpClient(strategy.strategyId))

      strategy.monitors.forEach(monitorName => {
        const monitor = this.monitors.get(monitorName)
        if (!monitor) throw new Error(
          `Instance "${instanceId}": strategy "${strategy.strategyId}" declares monitor dependency "${monitorName}" but it is not registered`
        )
        strategy.setMonitorReader(monitorName, monitor.getReader())
      })
    }
  }

  private initTriggerStates(): void {
    for (const entry of this.instances.values()) {
      entry.triggers
        .filter(t => t.enabled)
        .forEach(t => this.triggerStates.set(t.id, new TriggerState(t.conditions.length)))
    }
  }

  private setupMonitorHandlers(queue: ExecutionQueue): void {
    for (const [monitorName, monitor] of this.monitors) {
      monitor.setEmitHandler((key, data) =>
        this.onMonitorEmit(monitorName, key, data as Record<string, unknown>, queue)
      )
    }
  }

  private async onMonitorEmit(
    monitorName: string,
    key: string,
    data: Record<string, unknown>,
    queue: ExecutionQueue,
  ): Promise<void> {
    const now = Date.now()
    const promises: Promise<void>[] = []
    for (const entry of this.instances.values()) {
      entry.triggers.filter(t => t.enabled).forEach(trigger => {
        const triggerState = this.triggerStates.get(trigger.id)
        if (!triggerState) return
        this.applyMonitorEmitToTrigger(trigger, triggerState, monitorName, key, data, now)
        promises.push(this.checkAndFire(entry.instanceId, trigger, triggerState, entry.strategy, queue, now))
      })
    }
    await Promise.all(promises)
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
    for (const entry of this.instances.values()) {
      entry.triggers.filter(t => t.enabled).forEach(trigger =>
        trigger.conditions
          .filter((c): c is MonitorCondition => c.type === 'monitor')
          .flatMap(c => c.sources)
          .forEach(source => this.subscribeSource(source))
      )
    }
  }

  private unsubscribeMonitors(): void {
    for (const entry of this.instances.values()) {
      entry.triggers.forEach(trigger =>
        trigger.conditions
          .filter((c): c is MonitorCondition => c.type === 'monitor')
          .flatMap(c => c.sources)
          .forEach(source => this.unsubscribeSource(source))
      )
    }
  }

  private subscribeSource(source: MonitorSource): void {
    const monitor = this.monitors.get(source.monitorName)
    if (!monitor) return
    if (source.key === '*') {
      monitor.subscribeAll()
    } else if (monitor.mode !== 'standalone') {
      monitor.subscribe(source.key as never)
    }
    // Standalone monitors manage their own lifecycle — no subscribe(key) needed
  }

  private unsubscribeSource(source: MonitorSource): void {
    const monitor = this.monitors.get(source.monitorName)
    if (!monitor) return
    if (source.key === '*') {
      monitor.unsubscribeAll()
    } else if (monitor.mode !== 'standalone') {
      monitor.unsubscribe(source.key as never)
    }
  }

  private scheduleCronConditions(queue: ExecutionQueue): void {
    for (const entry of this.instances.values()) {
      entry.triggers.filter(t => t.enabled).forEach(trigger =>
        trigger.conditions.forEach((condition, i) => {
          if (condition.type === 'cron') this.scheduleCron(entry.instanceId, trigger, i, condition, entry.strategy, queue)
        })
      )
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private scheduleCron(
    instanceId: string,
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
      await this.checkAndFire(instanceId, trigger, triggerState, strategy, queue, now)
    })
    this.cronTasks.push(task)
  }

  private async checkAndFire(
      instanceId: string,
      trigger: Trigger,
      triggerState: TriggerState,
      strategy: IStrategy,
      queue: ExecutionQueue,
      now: number,
  ): Promise<void> {
    if (!triggerState.isComplete(trigger.conditions, trigger.window, now)) return
    const monitorData = triggerState.collectMonitorData(trigger.conditions)
    triggerState.reset()
    const context: StrategyContext = { instanceId, triggerId: trigger.id, monitorData, timestamp: now }
    const instructions = await strategy.run(context)
    await queue.pushBatch(instructions)
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
