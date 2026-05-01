import cron from 'node-cron'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { ExecutionInstruction, ExecutionQueue } from '../types/executor.js'
import type { CronTrigger, SubscribeTrigger, Trigger, TriggerFilter } from '../types/trigger.js'
import type { IStrategy, StrategyContext } from '../types/strategy.js'
import type { CredentialStore } from '../types/credential.js'

interface BundleEntry {
  triggers: Trigger[]
  strategy: IStrategy
}

export class TriggerManager {
  private readonly bundles = new Map<string, BundleEntry>()
  private readonly monitors = new Map<string, BaseMonitor>()
  private readonly cronTasks: cron.ScheduledTask[] = []
  private running = false

  registerMonitor(monitor: BaseMonitor): void {
    this.monitors.set(monitor.monitorName, monitor)
  }

  registerBundle(bundleId: string, triggers: Trigger[], strategy: IStrategy): void {
    this.bundles.set(bundleId, { triggers, strategy })
  }

  unregisterBundle(bundleId: string): void {
    this.bundles.delete(bundleId)
  }

  start(queue: ExecutionQueue, credentialStore?: CredentialStore): void {
    if (this.running) return
    this.running = true

    // Inject MonitorDataReaders and CredentialStore into each strategy
    for (const [, entry] of this.bundles) {
      if (credentialStore) {
        entry.strategy.setCredentialStore(credentialStore)
      }
      for (const trigger of entry.triggers) {
        if (trigger.type === 'subscribe') {
          const monitor = this.monitors.get(trigger.monitorName)
          if (monitor) {
            entry.strategy.setMonitorReader(trigger.key, monitor.getReader(trigger.key as never))
          }
        }
      }
    }

    // Set up monitor emit handlers — one handler per monitor, dispatches to all matching subscribe triggers
    for (const [monitorName, monitor] of this.monitors) {
      monitor.setEmitHandler(async (key, data) => {
        for (const [, entry] of this.bundles) {
          for (const trigger of entry.triggers) {
            if (
              trigger.type === 'subscribe' &&
              trigger.enabled &&
              trigger.monitorName === monitorName &&
              trigger.key === key
            ) {
              if (trigger.filter && !evaluateFilter(trigger.filter, data as Record<string, unknown>)) {
                continue
              }
              const context: StrategyContext = {
                triggerType: 'subscribe',
                triggerId: trigger.id,
                monitorKey: key,
                monitorData: data as Record<string, unknown>,
                timestamp: Date.now(),
              }
              const instructions = await entry.strategy.run(context)
              await queue.pushBatch(instructions)
            }
          }
        }
      })
    }

    // Subscribe monitors and schedule cron triggers
    for (const [, entry] of this.bundles) {
      for (const trigger of entry.triggers) {
        if (!trigger.enabled) continue

        if (trigger.type === 'subscribe') {
          const monitor = this.monitors.get(trigger.monitorName)
          if (monitor) {
            monitor.subscribe(trigger.key as never)
          }
        } else if (trigger.type === 'cron') {
          this.scheduleCron(trigger, entry.strategy, queue)
        }
      }
    }
  }

  stop(): void {
    if (!this.running) return
    this.running = false

    for (const task of this.cronTasks) {
      task.stop()
    }
    this.cronTasks.length = 0

    for (const [, entry] of this.bundles) {
      for (const trigger of entry.triggers) {
        if (trigger.type === 'subscribe') {
          const monitor = this.monitors.get(trigger.monitorName)
          if (monitor) {
            monitor.unsubscribe(trigger.key as never)
          }
        }
      }
    }
  }

  private scheduleCron(trigger: CronTrigger, strategy: IStrategy, queue: ExecutionQueue): void {
    const task = cron.schedule(trigger.expression, async () => {
      const context: StrategyContext = {
        triggerType: 'cron',
        triggerId: trigger.id,
        timestamp: Date.now(),
      }
      const instructions = await strategy.run(context)
      await queue.pushBatch(instructions)
    })
    this.cronTasks.push(task)
  }
}

function evaluateFilter(filter: TriggerFilter, data: Record<string, unknown>): boolean {
  const value = data[filter.field]
  const threshold = filter.value

  switch (filter.op) {
    case 'gt': return (value as number) > (threshold as number)
    case 'gte': return (value as number) >= (threshold as number)
    case 'lt': return (value as number) < (threshold as number)
    case 'lte': return (value as number) <= (threshold as number)
    case 'eq': return value === threshold
    case 'neq': return value !== threshold
  }
}
