import type { ZodObject, ZodRawShape } from 'zod'
import type { NamespacedKind } from '../types/materialization.js'
import type { MonitorContext } from '../types/monitorInstance.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'

/**
 * Component metadata decorators — the authoring surface of definePlugin's
 * class arrays.
 *
 * Two guardrails, deliberately:
 *  1. Decorators ONLY ATTACH metadata (a WeakMap keyed by the constructor).
 *     Registration happens exclusively through the plugin manifest arrays —
 *     importing a decorated class registers NOTHING. No import-order magic,
 *     no global scanning.
 *  2. They accept both decorator protocols (TC39 standard and legacy), same
 *     as the strategy decorators, so build targets don't matter.
 *
 * definePlugin() reads this metadata and lowers each class into the plain
 * registration objects the runtime understands.
 */

type ClassDecorator = (value: object, context?: unknown) => void

// ── @OwMonitor ────────────────────────────────────────────────────────────────

export interface OwMonitorMeta {
  /** Implementation id (short; plugin-qualified at load). */
  id: string
  /**
   * Contract this implementation serves. Defaults to `id` (own namespace).
   * Use a qualified id ('exchange/funding-rates') to SPECIALIZE another
   * plugin's contract — the class should subclass that contract's runner and
   * narrow its keySchema (values only, same fields).
   */
  contract?: string
  name?: string
  description?: string
  /** Credential requirement for instances (absent = credential-less). */
  credential?: { type: string; level: 'optional' | 'required' }
  /**
   * Top-level tuning params (Zod object, .meta() drives the form). Filled per
   * instance at creation, editable any time (an active one is rebuilt).
   */
  params?: ZodObject<ZodRawShape>
}

const monitorMeta = new WeakMap<object, OwMonitorMeta>()

/** Attach monitor-implementation metadata to a runner class (constructor: (ctx: MonitorContext)). */
export function OwMonitor(meta: OwMonitorMeta): ClassDecorator {
  return (value) => { monitorMeta.set(value, meta) }
}

export function owMonitorMeta(ctor: object): OwMonitorMeta | undefined {
  return monitorMeta.get(ctor)
}

/** Constructor shape definePlugin expects for @OwMonitor classes. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MonitorClass = new (ctx: MonitorContext) => BaseMonitor<string, any>

// ── @OwAccount ────────────────────────────────────────────────────────────────

export interface OwAccountMeta {
  /** Implementation id. Defaults to a kebab-cased class name at lowering. */
  id?: string
  kind: NamespacedKind
  /** Venue specialization — pins this implementation to one (kind, venue) cell. */
  venue?: string
  /** @deprecated Legacy name for {@link venue}. */
  type?: string
  displayName?: string
  /** Declared configuration schema — see AccountImplementation.paramsSchema. */
  paramsSchema?: ZodObject<ZodRawShape>
}

const accountMeta = new WeakMap<object, OwAccountMeta>()

/**
 * Attach account-implementation metadata to a reader class (constructor:
 * (accountName, session)). Also assigns the class's static `kind`/`venueType`
 * so it keeps working as a strategy slot declaration (`ReaderClass`).
 */
export function OwAccount(meta: OwAccountMeta): ClassDecorator {
  return (value) => {
    accountMeta.set(value, meta)
    const statics = value as { kind?: NamespacedKind; venueType?: string }
    statics.kind = meta.kind
    const venue = meta.venue ?? meta.type
    if (venue !== undefined) statics.venueType = venue
  }
}

export function owAccountMeta(ctor: object): OwAccountMeta | undefined {
  return accountMeta.get(ctor)
}

export type AccountClass = new (accountName: string, session: never, params?: Record<string, unknown>) => unknown

// ── @OwExecutor ───────────────────────────────────────────────────────────────

export interface OwExecutorMeta {
  /** Registry id. Defaults to the instance's executorName at lowering. */
  id?: string
  name?: string
  description?: string
}

const executorMeta = new WeakMap<object, OwExecutorMeta>()

/** Attach executor metadata to an executor class (zero-arg constructor). */
export function OwExecutor(meta: OwExecutorMeta = {}): ClassDecorator {
  return (value) => { executorMeta.set(value, meta) }
}

export function owExecutorMeta(ctor: object): OwExecutorMeta | undefined {
  return executorMeta.get(ctor)
}

// ── @OwStrategy ───────────────────────────────────────────────────────────────

export interface OwStrategyMeta {
  /** Registry id. Defaults to the probe instance's strategyId at lowering. */
  id?: string
  name?: string
  description?: string
}

const strategyMeta = new WeakMap<object, OwStrategyMeta>()

/**
 * Attach strategy display metadata to a strategy class. The strategy's ID and
 * dependency declarations still come from the class itself (fields or the
 * @Strategy/@Monitor/… declaration decorators) — this only carries what the
 * registry definition needs beyond them.
 */
export function OwStrategy(meta: OwStrategyMeta = {}): ClassDecorator {
  return (value) => { strategyMeta.set(value, meta) }
}

export function owStrategyMeta(ctor: object): OwStrategyMeta | undefined {
  return strategyMeta.get(ctor)
}
