/**
 * Manual monitor watches — the dashboard acting as one more subscriber.
 *
 * subscribe(key) is refcounted in BaseMonitor, so manual watches coexist with
 * strategy-instance subscriptions without disturbing them. Watches live in
 * process memory only: a restart drops them (deliberate — they are debugging
 * aids, not configuration).
 */
import type { OpenWhaleRuntime } from '@openwhaleorg/core'

const manualWatches = new Set<string>()

function watches(): Set<string> {
  return manualWatches
}

const STANDALONE_KEY = '(standalone)'

function watchId(monitorId: string, key: string): string {
  return `${monitorId}::${key}`
}

export function listManualWatches(monitorId: string): string[] {
  const prefix = `${monitorId}::`
  return [...watches()].filter(w => w.startsWith(prefix)).map(w => w.slice(prefix.length))
}

export function watchKey(runtime: OpenWhaleRuntime, monitorId: string, key: string): void {
  const monitor = runtime.getMonitorInstance(monitorId)
  if (!monitor) throw new Error(`Unknown monitor "${monitorId}"`)

  const isStandalone = monitor.mode === 'standalone'
  const effectiveKey = isStandalone ? STANDALONE_KEY : key
  if (!isStandalone && !key) throw new Error('key is required for subscribe-mode monitors')

  const id = watchId(monitorId, effectiveKey)
  if (watches().has(id)) return   // idempotent

  if (isStandalone) monitor.start()
  else monitor.subscribe(effectiveKey)
  watches().add(id)
}

export function unwatchKey(runtime: OpenWhaleRuntime, monitorId: string, key: string): void {
  const monitor = runtime.getMonitorInstance(monitorId)
  if (!monitor) throw new Error(`Unknown monitor "${monitorId}"`)

  const isStandalone = monitor.mode === 'standalone'
  const effectiveKey = isStandalone ? STANDALONE_KEY : key
  const id = watchId(monitorId, effectiveKey)
  if (!watches().delete(id)) return   // not manually watched — never touch instance-owned refcounts

  if (isStandalone) monitor.stop()
  else monitor.unsubscribe(effectiveKey)
}
