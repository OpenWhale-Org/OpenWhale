import type { IRegistry } from '../types/registry.js'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '../types/definition.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import type { IStrategy } from '../types/strategy.js'

export class Registry<TDefinition extends { id: string }, TInstance>
  implements IRegistry<TDefinition, TInstance>
{
  private readonly definitions = new Map<string, TDefinition>()
  private readonly instances = new Map<string, TInstance>()

  register(definition: TDefinition, instance: TInstance): void {
    this.definitions.set(definition.id, definition)
    this.instances.set(definition.id, instance)
  }

  unregister(id: string): void {
    this.definitions.delete(id)
    this.instances.delete(id)
  }

  get(id: string): TInstance | undefined {
    return this.instances.get(id)
  }

  getDefinition(id: string): TDefinition | undefined {
    return this.definitions.get(id)
  }

  list(): TDefinition[] {
    return Array.from(this.definitions.values())
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MonitorRegistry = IRegistry<MonitorDefinition, BaseMonitor<string, any>>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ExecutorRegistry = IRegistry<ExecutorDefinition, BaseExecutor<any>>
/** Strategy registry stores factory functions — each activate() call creates a fresh instance. */
export type StrategyRegistry = IRegistry<StrategyDefinition, () => IStrategy>

export function createMonitorRegistry(): MonitorRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Registry<MonitorDefinition, BaseMonitor<string, any>>()
}

export function createExecutorRegistry(): ExecutorRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Registry<ExecutorDefinition, BaseExecutor<any>>()
}

export function createStrategyRegistry(): StrategyRegistry {
  return new Registry<StrategyDefinition, () => IStrategy>()
}
