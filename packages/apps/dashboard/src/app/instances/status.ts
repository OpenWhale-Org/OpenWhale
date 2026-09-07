import type { StrategyInstanceView } from '@openwhaleorg/core'

/**
 * What an instance's status dot says, in one place.
 *
 * Running, and running for real? Dry run is the engine holding every
 * instruction instead of queueing it, so a dry-running instance looks exactly
 * as busy as a live one — same runs, same signals, same log — while placing
 * nothing. Green for that would be the dashboard agreeing with the mistake.
 * Amber says: it is on, and it is not trading.
 */
export function statusDot(instance: StrategyInstanceView): string {
  if (instance.problem) return 'var(--danger)'
  if (!instance.active) return 'var(--border)'
  return instance.options?.dryRun ? 'var(--warning)' : 'var(--success)'
}

export function statusTitle(instance: StrategyInstanceView): string {
  if (instance.problem) return instance.problem
  if (!instance.active) return 'Stopped'
  return instance.options?.dryRun
    ? 'Running in dry run — instructions are recorded, none reach a venue'
    : 'Running'
}
