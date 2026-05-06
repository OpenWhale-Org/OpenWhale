import type { MonitorSource, TriggerCondition } from '../types/trigger.js'

// ── Condition state ───────────────────────────────────────────────────────────

export interface ConditionState {
  /** Timestamp (ms) when this condition was last satisfied. null = not yet satisfied. */
  satisfiedAt: number | null
  /** For MonitorCondition: per-source last-satisfied data and timestamp. */
  sourceStates: Map<string, { data: Record<string, unknown>; satisfiedAt: number }>
}

function makeConditionState(): ConditionState {
  return { satisfiedAt: null, sourceStates: new Map() }
}

// ── Trigger state ─────────────────────────────────────────────────────────────

export class TriggerState {
  private readonly states: ConditionState[]

  constructor(conditionCount: number) {
    this.states = Array.from({ length: conditionCount }, makeConditionState)
  }

  satisfyMonitorSource(
    conditionIndex: number,
    sourceKey: string,
    data: Record<string, unknown>,
    now: number,
  ): void {
    this.states[conditionIndex]!.sourceStates.set(sourceKey, { data, satisfiedAt: now })
  }

  satisfyCron(conditionIndex: number, now: number): void {
    this.states[conditionIndex]!.satisfiedAt = now
  }

  isComplete(conditions: TriggerCondition[], window: number | undefined, now: number): boolean {
    return conditions.every((condition, i) => {
      const state = this.states[i]!
      if (condition.type === 'cron') return isWithinWindow(state.satisfiedAt, window, now)
      return condition.sources.every(source => this.isSourceSatisfied(source, state, window, now))
    })
  }

  collectMonitorData(conditions: TriggerCondition[]): Record<string, Record<string, unknown>> {
    return Object.fromEntries(
      conditions.flatMap((condition, i) => {
        if (condition.type !== 'monitor') return []
        return [...this.states[i]!.sourceStates.entries()].map(([k, s]) => [k, s.data])
      })
    )
  }

  reset(): void {
    this.states.forEach(state => {
      state.satisfiedAt = null
      state.sourceStates.clear()
    })
  }

  private isSourceSatisfied(
    source: MonitorSource,
    state: ConditionState,
    window: number | undefined,
    now: number,
  ): boolean {
    if (source.key === '*') {
      return [...state.sourceStates.entries()].some(
        ([k, s]) => k.startsWith(`${source.monitorName}:`) && isWithinWindow(s.satisfiedAt, window, now)
      )
    }
    const key = `${source.monitorName}:${source.key}`
    const sourceState = state.sourceStates.get(key)
    if (!sourceState || !isWithinWindow(sourceState.satisfiedAt, window, now)) {
      if (sourceState) state.sourceStates.delete(key)
      return false
    }
    return true
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function isWithinWindow(satisfiedAt: number | null, window: number | undefined, now: number): boolean {
  if (satisfiedAt === null) return false
  if (window === undefined) return true
  return now - satisfiedAt <= window
}
