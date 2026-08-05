import type { OpenWhaleRuntime } from '@openwhaleorg/core'

/**
 * Rolling count of monitor emits, in per-minute buckets.
 *
 * The alternative — counting lines in `dataDir/monitors/**.jsonl` — is a
 * gigabyte-scale scan for one number on a stats bar. This trades exactness
 * before the gateway started for a read that costs nothing: the meter reports
 * how long it has actually been watching, so the UI can say "since start"
 * instead of implying a full day it never saw.
 *
 * Handlers attach lazily and idempotently: monitors registered later (a plugin
 * install, a new instance) are picked up on the next sync.
 */
export class ActivityMeter {
  private readonly buckets = new Map<number, number>()
  private readonly hooked = new Set<object>()
  private readonly startedAt = Date.now()

  private static readonly MINUTE = 60_000
  private static readonly WINDOW_MINUTES = 24 * 60

  /** Attach to every monitor not already counted. Cheap enough to call per read. */
  sync(runtime: OpenWhaleRuntime): void {
    for (const def of runtime.listMonitors()) {
      const monitor = runtime.getMonitor(def.id)
      if (!monitor || this.hooked.has(monitor)) continue
      this.hooked.add(monitor)
      monitor.addEmitHandler(() => this.tick())
    }
  }

  private tick(): void {
    const minute = Math.floor(Date.now() / ActivityMeter.MINUTE)
    this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + 1)
    if (this.buckets.size > ActivityMeter.WINDOW_MINUTES + 60) this.prune(minute)
  }

  private prune(nowMinute: number): void {
    const oldest = nowMinute - ActivityMeter.WINDOW_MINUTES
    for (const m of this.buckets.keys()) if (m < oldest) this.buckets.delete(m)
  }

  /** Emits within the last `hours`, plus how much of that window we actually watched. */
  read(hours = 24): { count: number; windowHours: number; coveredMs: number } {
    const nowMinute = Math.floor(Date.now() / ActivityMeter.MINUTE)
    const from = nowMinute - hours * 60
    let count = 0
    for (const [minute, n] of this.buckets) if (minute >= from) count += n
    return {
      count,
      windowHours: hours,
      coveredMs: Math.min(Date.now() - this.startedAt, hours * 3_600_000),
    }
  }
}

export const activityMeter = new ActivityMeter()
