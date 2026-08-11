import cron from 'node-cron'
import { MonitorMode, type BaseMonitor } from '../monitor/BaseMonitor.js'
import type { EmitHandler } from '../types/monitor.js'
import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'
import type { CronCondition, MonitorCondition, MonitorSource, Trigger, TriggerFilter } from '../types/trigger.js'
import type { IStrategy, StrategyContext } from '../types/strategy.js'
import type { CredentialStore } from '../types/credential.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'
import type { StrategyParams } from '../types/instance.js'
import type { MonitorRegistry } from '../registry/Registry.js'
import { DBStrategyStore } from '../strategy/StrategyStore.js'
import { HttpClient } from '../strategy/HttpClient.js'
import { TriggerState } from './TriggerState.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('TriggerManager')

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
  /** Maps executor label → registry key; instructions carry labels until they are queued. */
  executorLabelToKey: Map<string, string>
  /**
   * Monitors kept running for their data alone. Subscribed and unsubscribed
   * with the trigger sources, but referenced by no condition — so their emits
   * satisfy nothing and fire nothing.
   */
  subscriptions: MonitorSource[]
}

export class TriggerManager {
  private readonly instances = new Map<string, InstanceEntry>()
  private readonly monitorRegistry: MonitorRegistry
  private readonly credentialStore: CredentialStore | undefined
  private readonly database: DatabaseAdapter | undefined
  /** Scheduled cron tasks keyed by instanceId, so deactivation can stop exactly its own. */
  private readonly cronTasks = new Map<string, cron.ScheduledTask[]>()
  /**
   * Emit handlers we attached, keyed by monitor registry key, so stop() can
   * detach them. The monitor object is kept because the registry entry may be
   * hot-replaced (CompiledLoader recompile) — detach must target the instance
   * the handler was attached to, and a replaced instance needs a re-attach.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly attachedEmitHandlers = new Map<string, { monitor: BaseMonitor<string, any>; handler: EmitHandler }>()
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
    readers: unknown[],
    credentialNames: string[],
    monitorLabelToKey: Map<string, string>,
    executorLabelToKey: Map<string, string>,
  ): void {
    strategy.setParams(params)
    strategy.setReaders(readers, credentialNames)
    strategy.setInstanceId(instanceId)
    if (this.credentialStore) strategy.setCredentialStore(this.credentialStore)
    if (this.database) strategy.setStore(new DBStrategyStore(instanceId, this.database))
    strategy.setHttpClient(new HttpClient(strategy.strategyId))
    strategy.setDynamicSources?.({
      addSubscription: source => this.addSubscription(instanceId, source),
      addTrigger: trigger => this.addTrigger(instanceId, trigger),
    })
    const monitorKeyToLabel = new Map(Array.from(monitorLabelToKey, ([label, key]) => [key, label]))
    for (const trigger of triggers) this.resolveTriggerSourceKeys(trigger, monitorLabelToKey)
    const entry: InstanceEntry = {
      instanceId, triggers, strategy, monitorLabelToKey, monitorKeyToLabel, executorLabelToKey,
      subscriptions: (strategy.subscriptions?.(params) ?? [])
        .map(source => this.resolveSourceKey(source, monitorLabelToKey)),
    }

    // Re-registration (e.g. re-activate with new params) must first release the
    // old entry's cron tasks and monitor subscriptions or they leak.
    if (this.instances.has(instanceId)) this.unregisterInstance(instanceId)
    this.instances.set(instanceId, entry)

    // If already running, immediately wire up the new instance
    if (this.running && this.queue) {
      this.injectMonitorReadersForEntry(entry)
      this.initTriggerStatesForEntry(entry)
      this.attachEmitHandlersForEntry(entry, this.queue)
      this.subscribeMonitorsForEntry(entry)
      this.scheduleCronConditionsForEntry(entry, this.queue)
    }
  }

  /**
   * Add a data subscription to a LIVE instance. Strategies that discover
   * worthwhile monitor keys at runtime — an auto-detected trading pair whose
   * spread feed must start collecting before any trigger can judge it — hand
   * them in here. The source joins the entry's subscription list, so
   * unregisterInstance releases it exactly like an activation-time one.
   */
  addSubscription(instanceId: string, source: MonitorSource): void {
    const entry = this.instances.get(instanceId)
    if (!entry) return
    const resolved = this.resolveSourceKey(source, entry.monitorLabelToKey)
    entry.subscriptions.push(resolved)
    if (this.running) this.subscribeSource(resolved, entry.monitorLabelToKey)
  }

  /**
   * Add a trigger to a LIVE instance. Monitor conditions only — cron
   * conditions are scheduled once at registration and a dynamic path would
   * double-schedule; a strategy that wants dynamic cron cadence should
   * declare it up front and gate in evaluate.
   */
  addTrigger(instanceId: string, trigger: Omit<Trigger, 'id' | 'strategyInstanceId'>): void {
    const entry = this.instances.get(instanceId)
    if (!entry) return
    if (trigger.conditions.some(c => c.type === 'cron')) {
      throw new Error('Dynamic triggers support monitor conditions only')
    }
    const full: Trigger = {
      ...trigger,
      id: `${instanceId}-trigger-dyn-${entry.triggers.length}`,
      strategyInstanceId: instanceId,
    }
    this.resolveTriggerSourceKeys(full, entry.monitorLabelToKey)
    entry.triggers.push(full)
    if (full.enabled) this.triggerStates.set(full.id, new TriggerState(full.conditions.length))
    if (this.running) {
      for (const condition of full.conditions) {
        if (condition.type !== 'monitor') continue
        for (const source of condition.sources) this.subscribeSource(source, entry.monitorLabelToKey)
      }
    }
  }

  unregisterInstance(instanceId: string): void {
    const entry = this.instances.get(instanceId)
    if (!entry) return
    entry.triggers.forEach(t => this.triggerStates.delete(t.id))
    if (this.running) this.unsubscribeMonitorsForEntry(entry)
    this.cronTasks.get(instanceId)?.forEach(t => t.stop())
    this.cronTasks.delete(instanceId)
    this.instances.delete(instanceId)
  }

  getStrategy(instanceId: string): IStrategy | undefined {
    return this.instances.get(instanceId)?.strategy
  }

  /**
   * Everything this instance listens to — trigger sources and data-only
   * subscriptions alike — as (registry key, monitor key) pairs. The dashboard
   * uses it to show an instance ONLY the events it actually consumes instead
   * of the venue-wide firehose.
   */
  getMonitorScope(instanceId: string): Array<{ monitor: string; key: string }> {
    const entry = this.instances.get(instanceId)
    if (!entry) return []
    const out: Array<{ monitor: string; key: string }> = []
    for (const source of this.monitorSourcesForEntry(entry)) {
      out.push({
        monitor: entry.monitorLabelToKey.get(source.monitorName) ?? source.monitorName,
        key: source.key,
      })
    }
    return out
  }

  /** Registry keys of the executors an instance uses (for account cleanup on release). */
  getExecutorKeys(instanceId: string): string[] {
    const entry = this.instances.get(instanceId)
    return entry ? Array.from(entry.executorLabelToKey.values()) : []
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
    for (const tasks of this.cronTasks.values()) tasks.forEach(t => t.stop())
    this.cronTasks.clear()
    this.unsubscribeMonitors()
    for (const { monitor, handler } of this.attachedEmitHandlers.values()) {
      monitor.removeEmitHandler(handler)
    }
    this.attachedEmitHandlers.clear()
  }

  // ── Start / stop helpers ──────────────────────────────────────────────────

  private injectMonitorReaders(): void {
    for (const entry of this.instances.values()) this.injectMonitorReadersForEntry(entry)
  }

  private injectMonitorReadersForEntry(entry: InstanceEntry): void {
    for (const [label, registryKey] of entry.monitorLabelToKey) {
      const monitor = this.monitorRegistry.get(registryKey)
      if (!monitor) throw new Error(
        `Instance "${entry.instanceId}": strategy "${entry.strategy.strategyId}" declares monitor "${registryKey}" but it is not registered`
      )
      // Readers are keyed by label — the strategy's own vocabulary
      entry.strategy.setMonitorReader(label, monitor.getReader())
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
      this.attachEmitHandler(def.id, queue)
    }
  }

  /** Attach our emit handler to a monitor exactly once, remembering it for stop(). */
  private attachEmitHandler(registryKey: string, queue: ExecutionQueue): void {
    const monitor = this.monitorRegistry.get(registryKey)
    if (!monitor) return
    const existing = this.attachedEmitHandlers.get(registryKey)
    if (existing) {
      if (existing.monitor === monitor) return
      // Registry entry was hot-replaced — detach from the old instance and re-attach
      existing.monitor.removeEmitHandler(existing.handler)
    }
    const handler: EmitHandler = (key: string, data: unknown) =>
      this.onMonitorEmit(registryKey, key, data as Record<string, unknown>, queue)
    monitor.addEmitHandler(handler)
    this.attachedEmitHandlers.set(registryKey, { monitor, handler })
  }

  /** Ensure handlers exist for the monitors a late-registered instance uses (e.g. hot-loaded monitors). */
  private attachEmitHandlersForEntry(entry: InstanceEntry, queue: ExecutionQueue): void {
    for (const registryKey of entry.monitorLabelToKey.values()) {
      this.attachEmitHandler(registryKey, queue)
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
        promises.push(this.checkAndFire(entry, trigger, triggerState, queue, now))
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
    for (const source of this.monitorSourcesForEntry(entry)) {
      this.subscribeSource(source, entry.monitorLabelToKey)
    }
  }

  private unsubscribeMonitors(): void {
    for (const entry of this.instances.values()) this.unsubscribeMonitorsForEntry(entry)
  }

  private unsubscribeMonitorsForEntry(entry: InstanceEntry): void {
    for (const source of this.monitorSourcesForEntry(entry)) {
      this.unsubscribeSource(source, entry.monitorLabelToKey)
    }
  }

  /**
   * Every monitor this instance keeps alive: the ones its triggers listen to,
   * plus the ones it only wants collecting. Both are subscribed identically —
   * the difference is that nothing references the latter in a condition, so
   * their emits reach no trigger state.
   */
  private monitorSourcesForEntry(entry: InstanceEntry): MonitorSource[] {
    return [
      ...entry.triggers
        .filter(t => t.enabled)
        .flatMap(trigger => trigger.conditions
          .filter((c): c is MonitorCondition => c.type === 'monitor')
          .flatMap(c => c.sources)),
      ...entry.subscriptions,
    ]
  }

  private resolveTriggerSourceKeys(trigger: Trigger, labelToKey: Map<string, string>): void {
    for (const condition of trigger.conditions) {
      if (condition.type !== 'monitor') continue
      for (const source of condition.sources) this.resolveSourceKey(source, labelToKey)
    }
  }

  private resolveSourceKey(source: MonitorSource, labelToKey: Map<string, string>): MonitorSource {
    if (!source.keyParams || (source.key && source.key !== '')) return source
    const registryKey = labelToKey.get(source.monitorName) ?? source.monitorName
    const monitor = this.monitorRegistry.get(registryKey)
    if (!monitor) throw new Error(`Monitor source references unknown monitor "${source.monitorName}"`)
    source.key = monitor.keyFor(source.keyParams)
    return source
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
        if (condition.type === 'cron') this.scheduleCron(entry, trigger, i, condition, queue)
      })
    )
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private scheduleCron(
    entry: InstanceEntry,
    trigger: Trigger,
    conditionIndex: number,
    condition: CronCondition,
    queue: ExecutionQueue,
  ): void {
    const task = cron.schedule(condition.expression, async () => {
      const now = Date.now()
      const triggerState = this.triggerStates.get(trigger.id)
      if (!triggerState) return
      triggerState.satisfyCron(conditionIndex, now)
      await this.checkAndFire(entry, trigger, triggerState, queue, now)
    }, condition.timezone ? { timezone: condition.timezone } : undefined)
    if (!this.cronTasks.has(entry.instanceId)) this.cronTasks.set(entry.instanceId, [])
    this.cronTasks.get(entry.instanceId)!.push(task)
  }

  private async checkAndFire(
      entry: InstanceEntry,
      trigger: Trigger,
      triggerState: TriggerState,
      queue: ExecutionQueue,
      now: number,
  ): Promise<void> {
    const { instanceId, strategy } = entry
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
    let instructions: ExecutionInstruction[]
    try {
      instructions = await strategy.run(context)
    } catch (err) {
      // Contain strategy failures here: callers are cron callbacks and monitor
      // emit handlers, where a rejection would otherwise go unhandled.
      log.error({ instanceId, triggerId: trigger.id, err }, 'Strategy run failed')
      return
    }
    // Instructions leave the strategy with executor LABELS; resolve them to
    // registry keys here — the only point where instructions enter the queue.
    const tagged = instructions.map(i => ({
      ...i,
      instanceId,
      executorId: entry.executorLabelToKey.get(i.executorId) ?? i.executorId,
    }))
    await queue.pushBatch(tagged)
    const event: StrategyRunEvent = { instanceId, triggerId: trigger.id, monitorData, instructions: tagged, timestamp: now }
    for (const handler of this.strategyRunHandlers) {
      try {
        handler(event)
      } catch (err) {
        log.error({ instanceId, err }, 'StrategyRunEvent handler failed')
      }
    }
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
