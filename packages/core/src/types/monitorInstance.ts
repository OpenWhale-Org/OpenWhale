import type { ZodObject, ZodRawShape } from 'zod'
import type { AdapterResolver } from './materialization.js'
import type { RawCredentialData } from './credential.js'
import type { ParamFieldDef } from './definition.js'
import type { BaseMonitor } from '../monitor/BaseMonitor.js'

/**
 * Monitor — three layers:
 *
 *   contract        = monitorName + keySchema + emitSchema + dataDir. The ONLY
 *                     layer strategies see: they read by (contract, key) and
 *                     trigger on (contract, keyParams). Registry id.
 *   implementation  = a class serving a contract. Same-contract subclassing is
 *                     SPECIALIZATION: the child redefines keySchema, narrowing
 *                     the parameter space it claims (venue literal etc.).
 *   instance        = a user-created runner of one implementation, optionally
 *                     bound to a credential. (implementation, credential) is
 *                     unique; a dispatch domain has ONE active instance.
 *
 * Dispatch: a subscription's concrete keyParams are evaluated against active
 * instances' keySchemas leaf-first (deepest prototype chain first) — first
 * match wins, ambiguity at equal depth is a loud error, the generic parent is
 * the natural fallback. Data all lands in the CONTRACT's dataDir, so consumers
 * never learn which instance produced it.
 */

export interface MonitorImplementation {
  /** Short id; qualified to '<plugin>/<id>' at load. */
  id: string
  /**
   * Contract this implementation serves. Unqualified names bind to this
   * plugin's own namespace; qualified names ('exchange/funding-rates')
   * specialize another plugin's contract.
   */
  contract: string
  displayName?: string
  description?: string
  /**
   * Credential requirement for instances of this implementation.
   * Absent = credential-less. The credential's raw data is handed to
   * create() — gated by the credential type's `raw` flag (the same gate as
   * executor raw slots: venue packages own both sides and opt in knowingly).
   */
  credential?: { type: string; level: 'optional' | 'required' }
  /**
   * Top-level tuning parameters (throttles, poll intervals, thresholds).
   * Filled per INSTANCE on the dashboard at creation, editable while the
   * instance is inactive, FROZEN once activated. Defaults apply via Zod;
   * validated values reach create() as ctx.params.
   */
  params?: ZodObject<ZodRawShape>
  /** Build the runner. Its monitorName MUST equal the contract's data name. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  create(ctx: MonitorContext): BaseMonitor<string, any>
}

/** Everything an implementation may need to construct its runner. */
export interface MonitorContext {
  adapters: AdapterResolver
  /** Resolved credential of the instance being activated (when bound). */
  credential?: { name: string; type: string; data: RawCredentialData }
  /** Instance params, validated against the implementation's schema (defaults applied). */
  params?: Record<string, unknown>
  dataDir?: string
}

/** Persisted monitor instance entity. */
export interface MonitorInstanceEntity {
  id: string
  /** Qualified implementation id. */
  implementation: string
  /** Qualified contract id (denormalized for listing). */
  contract: string
  /** Bound credential name. */
  credential?: string
  /** Instance tuning params (raw user input; validated at activation). */
  params?: Record<string, unknown>
  active: boolean
  createdAt: string
  updatedAt: string
}

/** Serializable instance view (dashboard Monitor Instances page). */
export interface MonitorInstanceView extends MonitorInstanceEntity {
  implementationDisplayName?: string
  credentialLevel?: 'optional' | 'required'
  /** Param form fields derived from the implementation's schema. */
  paramsFields?: ParamFieldDef[]
  /** Keys this instance currently serves (assignment table). */
  servingKeys?: string[]
  problem?: string
}

export interface MonitorInstanceStore {
  save(entity: MonitorInstanceEntity): Promise<void>
  get(id: string): Promise<MonitorInstanceEntity | null>
  list(): Promise<MonitorInstanceEntity[]>
  delete(id: string): Promise<void>
}
