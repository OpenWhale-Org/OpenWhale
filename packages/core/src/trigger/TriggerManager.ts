import cron from 'node-cron'
import { MonitorMode, type BaseMonitor } from '../monitor/BaseMonitor.js'
import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'
import type { CronCondition, MonitorCondition, MonitorSource, Trigger, TriggerFilter } from '../types/trigger.js'
import type { IStrategy, StrategyContext } from '../types/strategy.js'
import type { CredentialStore } from '../types/credential.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import type { StrategyParams } from '../types/instance.js'
import type { IAccount } from '../types/account.js'
import type { MonitorRegistry } from '../registry/Registry.js'
import { DBStrategyStore } from '../strategy/StrategyStore.js'
import { HttpClient } from '../strategy/HttpClient.js'
import { TriggerState } from './TriggerState.js'

export interface StrategyRunEvent {
  instanceId: string
  triggerId: string
  monitorData: Record<string, Record<string, unknown>>
  instructions: ExecutionInstruction[]
  timestamp: number
}

interface InstanceEntry {
  instanceId: string
  triggers: Trigger[]
  strategy: IStrategy
  /** Maps monitor label → registry key, for subscribe/unsubscribe lookups. */
  monitorLabelToKey: Map<string, string>
  /** Maps registry key → monitor label, for matching incoming monitor emits. */
  monitorKeyToLabel: Map<string, string>
}

export class TriggerManager {
  private readonly instances = new Map<string, InstanceEntry>()
  private readonly monitorRegistry: MonitorRegistry
  private readonly credentialStore: CredentialStore | undefined
  private readonly database: DatabaseAdapter | undefined
  private readonly cronTasks: cron.ScheduledTask[] = []
  private readonly triggerStates = new Map<string, TriggerState>()
  private running = false
  private queue: ExecutionQueue | undefined
  private readonly strategyRunHandlers: ((event: StrategyRunEvent) => void)[] = []

  constructor(
    monitorRegistry: MonitorRegistry,
    credentialStore?: CredentialStore,
    database?: DatabaseAdapter,
  ) {
    this.monitorRegistry = monitorRegistry
    this.credentialStore = credentialStore
    this.database = database
  }

  addStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void {
    this.strategyRunHandlers.push(handler)
  }

  removeStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void {
    const idx = this.strategyRunHandlers.indexOf(handler)
    if (idx !== -1) this.strategyRunHandlers.splice(idx, 1)
  }

  /** @deprecated Use addStrategyRunHandler instead */
  setStrategyRunHandler(handler: (event: StrategyRunEvent) => void): void {
    this.strategyRunHandlers.push(handler)
  }

  registerInstance(
    instanceId: string,
    strategy: IStrategy,
    triggers: Trigger[],
    params: StrategyParams,
    accounts: IAccount[],
    monitorLabelToKey: Map<string, string>,
  ): void {
    strategy.setParams(params)
    strategy.setAccounts(accounts)
    strategy.setInstanceId(instanceId)
    if (this.credentialStore) strategy.setCredentialStore(this.credentialStore)
    if (this.database) strategy.setStore(new DBStrategyStore(instanceId, this.database))
    strategy.setHttpClient(new HttpClient(strategy.strategyId))
    const monitorKeyToLabel = new Map(Array.from(monitorLabelToKey, ([label, key]) => [key, label]))
    const entry: InstanceEntry = { instanceId, triggers, strategy, monitorLabelToKey, monitorKeyToLabel }
    this.instances.set(instanceId, entry)

    // If already running, immediately wire up the new instance
    if (this.running && this.queue) {
      this.injectMonitorReadersForEntry(entry)
      this.initTriggerStatesForEntry(entry)
      this.subscribeMonitorsForEntry(entry)
      this.scheduleCronConditionsForEntry(entry, this.queue)
    }
  }

  unregisterInstance(instanceId: string): void {
    this.instances.get(instanceId)?.triggers.forEach(t => this.triggerStates.delete(t.id))
    this.instances.delete(instanceId)
  }

  start(queue: ExecutionQueue): void {
    if (this.running) return
    this.running = true
    this.queue = queue
    this.injectMonitorReaders()
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

  private injectMonitorReaders(): void {
    for (const entry of this.instances.values()) this.injectMonitorReadersForEntry(entry)
  }

  private injectMonitorReadersForEntry(entry: InstanceEntry): void {
    for (const [, registryKey] of entry.monitorLabelToKey) {
      const monitor = this.monitorRegistry.get(registryKey)
      if (!monitor) throw new Error(
        `Instance "${entry.instanceId}": strategy "${entry.strategy.strategyId}" declares monitor "${registryKey}" but it is not registered`
      )
      entry.strategy.setMonitorReader(registryKey, monitor.getReader())
    }
  }

  private initTriggerStates(): void {
    for (const entry of this.instances.values()) this.initTriggerStatesForEntry(entry)
  }

  private initTriggerStatesForEntry(entry: InstanceEntry): void {
    entry.triggers
      .filter(t => t.enabled)
      .forEach(t => this.triggerStates.set(t.id, new TriggerState(t.conditions.length)))
  }

  private setupMonitorHandlers(queue: ExecutionQueue): void {
    for (const def of this.monitorRegistry.list()) {
      const monitor = this.monitorRegistry.get(def.id)
      if (!monitor) continue
      monitor.addEmitHandler((key: string, data: unknown) =>
        this.onMonitorEmit(def.id, key, data as Record<string, unknown>, queue)
      )
    }
  }

  private async onMonitorEmit(
    registryKey: string,
    key: string,
    data: Record<string, unknown>,
    queue: ExecutionQueue,
  ): Promise<void> {
    const now = Date.now()
    const promises: Promise<void>[] = []
    for (const entry of this.instances.values()) {
      // Translate registry key to the label used in this instance's trigger conditions
      const label = entry.monitorKeyToLabel.get(registryKey) ?? registryKey
      entry.triggers.filter(t => t.enabled).forEach(trigger => {
        const triggerState = this.triggerStates.get(trigger.id)
        if (!triggerState) return
        this.applyMonitorEmitToTrigger(trigger, triggerState, label, key, data, now)
        promises.push(this.checkAndFire(entry.instanceId, trigger, triggerState, entry.strategy, queue, now))
      })
    }
    await Promise.all(promises)
  }

  private applyMonitorEmitToTrigger(
    trigger: Trigger,
    triggerState: TriggerState,
    label: string,
    key: string,
    data: Record<string, unknown>,
    now: number,
  ): void {
    trigger.conditions.forEach((condition, i) => {
      if (condition.type !== 'monitor') return
      condition.sources
        .filter(s => s.monitorName === label)
        .filter(s => s.key === '*' || s.key === key)
        .filter(s => !s.filter || evaluateFilter(s.filter, data))
        .forEach(s => triggerState.satisfyMonitorSource(i, sourceKey(s, key), data, now))
    })
  }

  private subscribeMonitors(): void {
    for (const entry of this.instances.values()) this.subscribeMonitorsForEntry(entry)
  }

  private subscribeMonitorsForEntry(entry: InstanceEntry): void {
    entry.triggers.filter(t => t.enabled).forEach(trigger =>
      trigger.conditions
        .filter((c): c is MonitorCondition => c.type === 'monitor')
        .flatMap(c => c.sources)
        .forEach(source => this.subscribeSource(source, entry.monitorLabelToKey))
    )
  }

  private unsubscribeMonitors(): void {
    for (const entry of this.instances.values()) {
      entry.triggers.forEach(trigger =>
        trigger.conditions
          .filter((c): c is MonitorCondition => c.type === 'monitor')
          .flatMap(c => c.sources)
          .forEach(source => this.unsubscribeSource(source, entry.monitorLabelToKey))
      )
    }
  }

  private subscribeSource(source: MonitorSource, labelToKey: Map<string, string>): void {
    const registryKey = labelToKey.get(source.monitorName) ?? source.monitorName
    const monitor = this.monitorRegistry.get(registryKey)
    if (!monitor) return
    if (source.key === '*') {
      monitor.subscribeAll()
    } else if (monitor.mode !== 'standalone') {
      monitor.subscribe(source.key as never)
    }
    // Standalone monitors manage their own lifecycle — no subscribe(key) needed
  }

  private unsubscribeSource(source: MonitorSource, labelToKey: Map<string, string>): void {
    const registryKey = labelToKey.get(source.monitorName) ?? source.monitorName
    const monitor = this.monitorRegistry.get(registryKey)
    if (!monitor) return
    if (source.key === '*') {
      monitor.unsubscribeAll()
    } else if (monitor.mode !== 'standalone') {
      monitor.unsubscribe(source.key as never)
    }
  }

  private scheduleCronConditions(queue: ExecutionQueue): void {
    for (const entry of this.instances.values()) this.scheduleCronConditionsForEntry(entry, queue)
  }

  private scheduleCronConditionsForEntry(entry: InstanceEntry, queue: ExecutionQueue): void {
    entry.triggers.filter(t => t.enabled).forEach(trigger =>
      trigger.conditions.forEach((condition, i) => {
        if (condition.type === 'cron') this.scheduleCron(entry.instanceId, trigger, i, condition, entry.strategy, queue)
      })
    )
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
    const context: StrategyContext = {
      instanceId,
      triggerId: trigger.id,
      monitorData,
      timestamp: now,
      getData(monitorLabel: string, key: string) {
        return monitorData[`${monitorLabel}:${key}`]
      },
    }
    const instructions = await strategy.run(context)
    const tagged = instructions.map(i => ({ ...i, instanceId }))
    await queue.pushBatch(tagged)
    const event: StrategyRunEvent = { instanceId, triggerId: trigger.id, monitorData, instructions: tagged, timestamp: now }
    for (const handler of this.strategyRunHandlers) handler(event)
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
