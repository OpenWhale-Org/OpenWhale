import { BaseMonitor, MonitorMode } from './BaseMonitor.js'
import type { MonitorOptions, EmitHandler, MonitorPlotDef } from '../types/monitor.js'
import type { ZodObject, ZodRawShape } from 'zod'
import type {
  MonitorContext,
  MonitorImplementation,
  MonitorInstanceEntity,
  MonitorInstanceStore,
  MonitorInstanceView,
} from '../types/monitorInstance.js'
import type { AdapterResolver } from '../types/materialization.js'
import type { CredentialStore } from '../types/credential.js'
import { generateId } from '../utils/id.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('MonitorInstanceManager')

/**
 * The contract façade — what the registry (and thus TriggerManager and the
 * dashboard) sees for a contract served by implementations/instances. It is a
 * regular Subscribe-mode BaseMonitor: subscriptions refcount here, and
 * first-subscribe/last-unsubscribe route the key to the serving ACTIVE
 * instance. Emissions from every active instance are forwarded through it.
 * It never persists — the instances already write the contract's dataDir.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class ContractMonitor extends BaseMonitor<string, any> {
  override readonly mode = MonitorMode.Subscribe

  constructor(
    private readonly dataName: string,
    private readonly contractId: string,
    private readonly manager: MonitorInstanceManager,
    options?: MonitorOptions,
  ) {
    super(options)
  }

  get monitorName() { return this.dataName }

  override get keySchema(): ZodObject<ZodRawShape> | undefined {
    return this.manager.contractKeySchema(this.contractId)
  }

  override get emitSchema(): ZodObject<ZodRawShape> | undefined {
    return this.manager.contractEmitSchema(this.contractId)
  }

  /**
   * The façade never backfills — the serving INSTANCE does, when its
   * subscription is routed. This reports the contract's capability for the
   * definition/dashboard.
   */
  override get supportsBackfill(): boolean {
    return this.manager.contractSupportsBackfill(this.contractId)
  }

  /** Merge in whatever the serving instances are backfilling — the façade's own map is always empty. */
  override status() {
    const base = super.status()
    const keys = this.manager.contractBackfillingKeys(this.contractId)
    return keys.length > 0 ? { ...base, backfillingKeys: keys } : base
  }

  override keyFor(params: Record<string, unknown>): string {
    const key = super.keyFor(params)
    this.manager.rememberKeyParams(this.contractId, key, params)
    return key
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override plots(): MonitorPlotDef<any>[] {
    return this.manager.contractPlots(this.contractId)
  }

  protected override startSubscribe(key: string): void {
    this.manager.routeSubscribe(this.contractId, key)
  }

  protected override stopSubscribe(key: string): void {
    this.manager.routeUnsubscribe(this.contractId, key)
  }

  /** Instances persist; the façade must never double-write. */
  protected override async append(): Promise<void> {}

  /** Called by the manager when an active instance emits. */
  async forward(key: string, data: unknown): Promise<void> {
    await this.emitForward(key, data)
  }

  private async emitForward(key: string, data: unknown): Promise<void> {
    // BaseMonitor.emit is protected — this indirection keeps it that way for others
    await (this as unknown as { emit(key: string, data: unknown): Promise<void> }).emit(key, data)
  }
}

interface ImplRecord {
  impl: MonitorImplementation
  owner: string
  /** Prototype-chain depth of the runner class — leaf-first dispatch order. Known after first construction/probe. */
  depth?: number
  /**
   * A live runner to read schemas THROUGH (the registration probe, replaced by
   * the latest activated runner). Never store the schema value itself: getters
   * like the venue dropdown query the adapter matrix at read time, and a
   * snapshot would freeze the option list at whatever plugins were loaded
   * when this implementation registered.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemaSource?: BaseMonitor<string, any>
}

interface ContractRecord {
  /** Qualified registry id, e.g. 'exchange/funding-rates'. */
  contractId: string
  /** Unqualified data name (dataDir path segment), e.g. 'funding-rates'. */
  dataName: string
  facade: ContractMonitor
  impls: Map<string, ImplRecord>
  /** key → params, learned through facade.keyFor (structured subscriptions). */
  keyParams: Map<string, Record<string, unknown>>
  /** key → serving instance id. */
  assignments: Map<string, string>
  /** Subscribed keys nobody serves yet — retried when an instance activates. */
  pendingKeys: Set<string>
}

interface ActiveInstance {
  entity: MonitorInstanceEntity
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  monitor: BaseMonitor<string, any>
  depth: number
  forwardHandler: EmitHandler
}

function prototypeDepth(obj: object): number {
  let depth = 0
  for (let p = Object.getPrototypeOf(obj); p; p = Object.getPrototypeOf(p)) depth++
  return depth
}

export interface MonitorInstanceManagerOptions {
  store: MonitorInstanceStore
  adapters: AdapterResolver
  credentials?: CredentialStore
  dataDir?: string
  /** Raw-materialization gate: whether this credential type opts into raw. */
  allowsRaw?: (type: string) => boolean
  /** Called when a new contract appears, so the runtime can register the façade. */
  onContractCreated?: (contractId: string, facade: ContractMonitor) => void
}

/**
 * Owns the contract/implementation/instance tables, instance lifecycle
 * (create/activate/deactivate/delete) and key dispatch.
 *
 * Rules enforced here:
 *  - (implementation, credential) unique among instances
 *  - single-active per implementation (the dispatch domain)
 *  - all ACTIVE instances of a contract share identical keySchema field
 *    structure (values may narrow; shape may not change)
 *  - a key is served by exactly one active instance: leaf-first schema match
 *    when params are known; single-active shortcut otherwise; ambiguity at
 *    equal depth is a loud error, never a silent pick
 */
export class MonitorInstanceManager {
  private readonly contracts = new Map<string, ContractRecord>()
  private readonly implToContract = new Map<string, string>()
  private readonly actives = new Map<string, ActiveInstance>()
  private readonly options: MonitorInstanceManagerOptions

  constructor(options: MonitorInstanceManagerOptions) {
    this.options = options
  }

  // ── Registration ──────────────────────────────────────────────────────────

  /** Register an implementation; creates the contract façade on first sight. */
  registerImplementation(owner: string, impl: MonitorImplementation): ContractMonitor {
    const implId = impl.id.includes('/') ? impl.id : `${owner}/${impl.id}`
    const contractId = impl.contract.includes('/') ? impl.contract : `${owner}/${impl.contract}`
    const dataName = contractId.slice(contractId.indexOf('/') + 1)

    if (this.implToContract.has(implId)) {
      throw new Error(`Monitor implementation "${implId}" is already registered`)
    }

    let record = this.contracts.get(contractId)
    if (!record) {
      const facade = new ContractMonitor(dataName, contractId, this, {
        ...(this.options.dataDir !== undefined ? { dataDir: this.options.dataDir } : {}),
      })
      record = {
        contractId, dataName, facade,
        impls: new Map(), keyParams: new Map(), assignments: new Map(), pendingKeys: new Set(),
      }
      this.contracts.set(contractId, record)
      this.options.onContractCreated?.(contractId, facade)
    }

    const rec: ImplRecord = { impl: { ...impl, id: implId, contract: contractId }, owner }
    // Credential-less implementations are probeable — extract schemas/depth now
    // so the watch form and dispatch work before any instance is activated.
    if (!impl.credential) {
      try {
        const probe = impl.create(this.probeContext())
        rec.depth = prototypeDepth(probe)
        rec.schemaSource = probe
      } catch (err) {
        log.warn({ impl: implId, err }, 'Implementation probe failed — schemas resolve at activation')
      }
    }
    record.impls.set(implId, rec)
    this.implToContract.set(implId, contractId)
    return record.facade
  }

  /** Remove a plugin's implementations. Active instances of them are deactivated. */
  async unregisterOwner(owner: string): Promise<void> {
    for (const record of this.contracts.values()) {
      for (const [implId, rec] of record.impls) {
        if (rec.owner !== owner) continue
        for (const active of Array.from(this.actives.values())) {
          if (active.entity.implementation === implId) await this.deactivate(active.entity.id, { persist: false })
        }
        record.impls.delete(implId)
        this.implToContract.delete(implId)
      }
    }
  }

  private probeContext(): MonitorContext {
    return {
      adapters: this.options.adapters,
      ...(this.options.dataDir !== undefined ? { dataDir: this.options.dataDir } : {}),
    }
  }

  // ── Contract introspection (façade callbacks) ─────────────────────────────

  contractKeySchema(contractId: string): ZodObject<ZodRawShape> | undefined {
    // The shallowest (most generic) implementation defines the contract's
    // public key structure; specializations only narrow values. Read LIVE
    // through the runner so option lists (venue dropdowns) reflect every
    // plugin loaded by now, not just those present at registration.
    return this.schemaSourceOf(contractId, s => s.keySchema !== undefined)?.keySchema
  }

  contractEmitSchema(contractId: string): ZodObject<ZodRawShape> | undefined {
    return this.schemaSourceOf(contractId, s => s.emitSchema !== undefined)?.emitSchema
  }

  /**
   * Whether ANY implementation of this contract can backfill history. Read
   * through the runners: an implementation that reconstructs from an archive
   * gives the contract the capability even when a sibling can only observe
   * live (dispatch decides which one actually serves a given key).
   */
  contractSupportsBackfill(contractId: string): boolean {
    return this.schemaSourceOf(contractId, s => s.supportsBackfill) !== undefined
  }

  /** Keys the contract's ACTIVE instances are currently backfilling (the façade never runs one itself). */
  contractBackfillingKeys(contractId: string): string[] {
    const keys: string[] = []
    for (const active of this.actives.values()) {
      if (active.entity.contract !== contractId) continue
      keys.push(...(active.monitor.status().backfillingKeys ?? []))
    }
    return keys
  }

  /** The contract's dashboard panels — read through the schema source (probe/live runner). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  contractPlots(contractId: string): MonitorPlotDef<any>[] {
    return this.schemaSourceOf(contractId, s => s.plots().length > 0)?.plots() ?? []
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private schemaSourceOf(contractId: string, has: (source: BaseMonitor<string, any>) => boolean): BaseMonitor<string, any> | undefined {
    const record = this.contracts.get(contractId)
    if (!record) return undefined
    const impls = Array.from(record.impls.values()).filter(r => r.schemaSource && has(r.schemaSource))
    impls.sort((a, b) => (a.depth ?? Infinity) - (b.depth ?? Infinity))
    return impls[0]?.schemaSource
  }

  rememberKeyParams(contractId: string, key: string, params: Record<string, unknown>): void {
    this.contracts.get(contractId)?.keyParams.set(key, params)
  }

  // ── Instance lifecycle ────────────────────────────────────────────────────

  async createInstance(input: { implementation: string; credential?: string; params?: Record<string, unknown> }): Promise<MonitorInstanceEntity> {
    const contractId = this.implToContract.get(input.implementation)
    if (!contractId) throw new Error(`Unknown monitor implementation "${input.implementation}"`)
    const rec = this.contracts.get(contractId)!.impls.get(input.implementation)!

    if (input.params !== undefined) this.validateParams(rec.impl, input.params)

    if (rec.impl.credential?.level === 'required' && !input.credential) {
      throw new Error(
        `Monitor implementation "${input.implementation}" requires a "${rec.impl.credential.type}" credential — bind one`
      )
    }
    if (input.credential && !rec.impl.credential) {
      throw new Error(`Monitor implementation "${input.implementation}" is credential-less — remove the credential`)
    }
    if (input.credential) {
      await this.checkCredential(rec.impl, input.credential)
    }

    // (implementation, credential) unique — same config twice is the same runner
    for (const existing of await this.options.store.list()) {
      if (existing.implementation === input.implementation && (existing.credential ?? null) === (input.credential ?? null)) {
        throw new Error(
          `A monitor instance for "${input.implementation}" with this credential configuration already exists ("${existing.id}")`
        )
      }
    }

    const now = new Date().toISOString()
    const entity: MonitorInstanceEntity = {
      id: generateId('moni'),
      implementation: input.implementation,
      contract: contractId,
      ...(input.credential !== undefined ? { credential: input.credential } : {}),
      ...(input.params !== undefined ? { params: input.params } : {}),
      active: false,
      createdAt: now,
      updatedAt: now,
    }
    await this.options.store.save(entity)
    return entity
  }

  private validateParams(impl: MonitorImplementation, params: Record<string, unknown>): void {
    if (!impl.params) {
      if (Object.keys(params).length > 0) {
        throw new Error(`Monitor implementation "${impl.id}" declares no params`)
      }
      return
    }
    const result = impl.params.safeParse(params)
    if (!result.success) {
      throw new Error(`Invalid params for "${impl.id}": ${result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    }
  }

  /**
   * Update an instance's tuning params. Params FREEZE on activation — the
   * running monitor was constructed from them; deactivate first to edit.
   */
  async updateInstanceParams(id: string, params: Record<string, unknown>): Promise<void> {
    const entity = await this.options.store.get(id)
    if (!entity) throw new Error(`Unknown monitor instance "${id}"`)
    if (this.actives.has(id)) {
      throw new Error(`Monitor instance "${id}" is active — params are frozen; deactivate it to edit`)
    }
    const rec = this.contracts.get(entity.contract)?.impls.get(entity.implementation)
    if (rec) this.validateParams(rec.impl, params)
    entity.params = params
    entity.updatedAt = new Date().toISOString()
    await this.options.store.save(entity)
  }

  /** The implementation's params schema (dashboard form derivation). */
  paramsSchemaOf(implId: string): MonitorImplementation['params'] {
    const contractId = this.implToContract.get(implId)
    return contractId ? this.contracts.get(contractId)?.impls.get(implId)?.impl.params : undefined
  }

  private async checkCredential(impl: MonitorImplementation, credentialName: string): Promise<void> {
    if (!this.options.credentials) throw new Error('No CredentialStore configured — cannot bind monitor credentials')
    const { type } = await this.options.credentials.getByName(credentialName)
    if (impl.credential && impl.credential.type !== type) {
      throw new Error(
        `Monitor implementation "${impl.id}" requires a "${impl.credential.type}" credential, but "${credentialName}" is "${type}"`
      )
    }
    if (this.options.allowsRaw && !this.options.allowsRaw(type)) {
      throw new Error(
        `Credential type "${type}" does not allow raw materialization — monitor instances receive the raw data, ` +
        `so the type must set raw: true`
      )
    }
  }

  async activate(id: string): Promise<void> {
    const entity = await this.options.store.get(id)
    if (!entity) throw new Error(`Unknown monitor instance "${id}"`)
    if (this.actives.has(id)) return
    const record = this.contracts.get(entity.contract)
    const rec = record?.impls.get(entity.implementation)
    if (!record || !rec) throw new Error(`Monitor instance "${id}": implementation "${entity.implementation}" is not registered`)

    // Single-active per implementation (the dispatch domain)
    for (const active of this.actives.values()) {
      if (active.entity.implementation === entity.implementation) {
        throw new Error(
          `Implementation "${entity.implementation}" already has an active instance ("${active.entity.id}") — ` +
          `deactivate it first (single-active per dispatch domain)`
        )
      }
    }

    const ctx: MonitorContext = this.probeContext()
    // Params freeze here: the runner is constructed from the validated set
    // (schema defaults applied), so edits require deactivate → edit → activate.
    if (rec.impl.params) {
      const parsed = rec.impl.params.safeParse(entity.params ?? {})
      if (!parsed.success) {
        throw new Error(
          `Monitor instance "${id}" has invalid params: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`
        )
      }
      ctx.params = parsed.data as Record<string, unknown>
    } else if (entity.params) {
      ctx.params = entity.params
    }
    if (entity.credential) {
      if (!this.options.credentials) throw new Error('No CredentialStore configured')
      const { type, data } = await this.options.credentials.getByName(entity.credential)
      await this.checkCredential(rec.impl, entity.credential)
      ctx.credential = { name: entity.credential, type, data }
    } else if (rec.impl.credential?.level === 'required') {
      throw new Error(`Monitor instance "${id}" has no credential bound but "${entity.implementation}" requires one`)
    }

    const monitor = rec.impl.create(ctx)
    if (monitor.monitorName !== record.dataName) {
      throw new Error(
        `Monitor instance "${id}": runner's monitorName "${monitor.monitorName}" does not match ` +
        `contract data name "${record.dataName}" — data would land in the wrong directory`
      )
    }
    const depth = prototypeDepth(monitor)
    rec.depth = rec.depth ?? depth
    // The live runner supersedes the probe as the schema source
    rec.schemaSource = monitor
    const ks = monitor.keySchema

    // Guardrail: active instances of one contract must agree on key STRUCTURE
    // (field names + order); specializations narrow values only.
    if (ks) {
      for (const other of this.actives.values()) {
        if (other.entity.contract !== entity.contract) continue
        const otherSchema = other.monitor.keySchema
        if (!otherSchema) continue
        const a = Object.keys(ks.shape).join(':')
        const b = Object.keys(otherSchema.shape).join(':')
        if (a !== b) {
          throw new Error(
            `Monitor instance "${id}": keySchema fields (${a}) differ from active instance ` +
            `"${other.entity.id}" (${b}) — specializations may narrow values, never reshape keys`
          )
        }
      }
    }

    const forwardHandler: EmitHandler = (key, data) => record.facade.forward(key, data)
    monitor.addEmitHandler(forwardHandler)
    this.actives.set(id, { entity, monitor, depth, forwardHandler })

    entity.active = true
    entity.updatedAt = new Date().toISOString()
    await this.options.store.save(entity)

    // Serve keys that were subscribed while nobody covered them
    for (const key of Array.from(record.pendingKeys)) {
      this.tryRoute(record, key)
    }
  }

  async deactivate(id: string, { persist = true }: { persist?: boolean } = {}): Promise<void> {
    const active = this.actives.get(id)
    if (!active) return
    const record = this.contracts.get(active.entity.contract)
    if (record) {
      for (const [key, instanceId] of Array.from(record.assignments)) {
        if (instanceId !== id) continue
        try {
          active.monitor.unsubscribe(key)
        } catch (err) {
          log.warn({ instance: id, key, err }, 'Unsubscribe during deactivation failed')
        }
        record.assignments.delete(key)
        record.pendingKeys.add(key)
      }
    }
    active.monitor.removeEmitHandler(active.forwardHandler)
    this.actives.delete(id)
    if (persist) {
      active.entity.active = false
      active.entity.updatedAt = new Date().toISOString()
      await this.options.store.save(active.entity)
    }
  }

  async deleteInstance(id: string): Promise<void> {
    await this.deactivate(id)
    await this.options.store.delete(id)
  }

  /** Restore persisted-active instances (runtime start). Failures skip, not brick. */
  async restore(): Promise<void> {
    await this.ensureDefaultInstances()
    for (const entity of await this.options.store.list()) {
      if (!entity.active) continue
      try {
        // stored active=true; activate() re-saves harmlessly
        await this.activate(entity.id)
      } catch (err) {
        log.error({ instance: entity.id, err }, 'Failed to restore monitor instance — skipping')
      }
    }
  }

  /**
   * Credential-less implementations get a default instance automatically —
   * public market data must not demand ceremony. Created (active) only when
   * the implementation has NO instance at all: a user who deactivated the
   * default keeps it deactivated across restarts.
   */
  private async ensureDefaultInstances(): Promise<void> {
    const existing = await this.options.store.list()
    for (const record of this.contracts.values()) {
      for (const rec of record.impls.values()) {
        if (rec.impl.credential) continue
        if (existing.some(e => e.implementation === rec.impl.id)) continue
        try {
          const entity = await this.createInstance({ implementation: rec.impl.id })
          entity.active = true
          await this.options.store.save(entity)
        } catch (err) {
          log.warn({ impl: rec.impl.id, err }, 'Default monitor instance creation failed')
        }
      }
    }
  }

  /** Deactivate all actives without flipping their persisted `active` flag (runtime stop). */
  async stopAll(): Promise<void> {
    for (const id of Array.from(this.actives.keys())) {
      await this.deactivate(id, { persist: false })
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  routeSubscribe(contractId: string, key: string): void {
    const record = this.contracts.get(contractId)
    if (!record) return
    if (!this.tryRoute(record, key)) {
      record.pendingKeys.add(key)
      log.warn(
        { contract: contractId, key },
        'No active monitor instance serves this key — create/activate one (data will flow once it exists)'
      )
    }
  }

  routeUnsubscribe(contractId: string, key: string): void {
    const record = this.contracts.get(contractId)
    if (!record) return
    record.pendingKeys.delete(key)
    const instanceId = record.assignments.get(key)
    if (!instanceId) return
    record.assignments.delete(key)
    const active = this.actives.get(instanceId)
    if (active) {
      try {
        active.monitor.unsubscribe(key)
      } catch (err) {
        log.warn({ instance: instanceId, key, err }, 'Unsubscribe failed')
      }
    }
  }

  /** Assign a key to its serving instance. Returns false when nobody can serve it. */
  private tryRoute(record: ContractRecord, key: string): boolean {
    if (record.assignments.has(key)) return true
    const candidates = Array.from(this.actives.values())
      .filter(a => a.entity.contract === record.contractId)
    if (candidates.length === 0) return false

    let chosen: ActiveInstance | undefined
    const params = record.keyParams.get(key)
    if (candidates.length === 1) {
      // Single active instance — no matching needed, the overwhelming common case
      chosen = candidates[0]!
      if (params) {
        const schema = chosen.monitor.keySchema
        if (schema && !schema.safeParse(params).success) {
          log.warn(
            { contract: record.contractId, key, instance: chosen.entity.id },
            'Key params do not match the only active instance\'s keySchema — routing anyway (no alternative)'
          )
        }
      }
    } else if (params) {
      // Leaf-first: deepest prototype chain first; first schema match wins,
      // ties at equal depth are ambiguity — a loud error, never a silent pick.
      const matching = candidates
        .filter(c => c.monitor.keySchema?.safeParse(params).success ?? false)
        .sort((a, b) => b.depth - a.depth)
      if (matching.length === 0) return false
      const deepest = matching.filter(m => m.depth === matching[0]!.depth)
      if (deepest.length > 1) {
        throw new Error(
          `Ambiguous dispatch for key "${key}" on contract "${record.contractId}": instances ` +
          `${deepest.map(d => `"${d.entity.id}"`).join(' and ')} both claim it — deactivate one`
        )
      }
      chosen = matching[0]!
    } else {
      throw new Error(
        `Contract "${record.contractId}" has ${candidates.length} active instances but key "${key}" was ` +
        `subscribed without structured params — subscribe via keyParams so dispatch can match keySchemas`
      )
    }

    record.assignments.set(key, chosen.entity.id)
    record.pendingKeys.delete(key)
    chosen.monitor.subscribe(key)
    return true
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  listImplementations(): Array<{ id: string; contract: string; owner: string; displayName?: string; description?: string; credential?: { type: string; level: 'optional' | 'required' } }> {
    const out = []
    for (const record of this.contracts.values()) {
      for (const rec of record.impls.values()) {
        out.push({
          id: rec.impl.id,
          contract: record.contractId,
          owner: rec.owner,
          ...(rec.impl.displayName !== undefined ? { displayName: rec.impl.displayName } : {}),
          ...(rec.impl.description !== undefined ? { description: rec.impl.description } : {}),
          ...(rec.impl.credential !== undefined ? { credential: rec.impl.credential } : {}),
        })
      }
    }
    return out
  }

  async listInstances(): Promise<MonitorInstanceView[]> {
    const entities = await this.options.store.list()
    return entities.map(entity => {
      const record = this.contracts.get(entity.contract)
      const rec = record?.impls.get(entity.implementation)
      const serving = record
        ? Array.from(record.assignments).filter(([, iid]) => iid === entity.id).map(([key]) => key)
        : []
      return {
        ...entity,
        active: this.actives.has(entity.id),
        ...(rec?.impl.displayName !== undefined ? { implementationDisplayName: rec.impl.displayName } : {}),
        ...(rec?.impl.credential !== undefined ? { credentialLevel: rec.impl.credential.level } : {}),
        servingKeys: serving,
        ...(rec ? {} : { problem: `implementation "${entity.implementation}" is not registered` }),
      }
    })
  }

  /** Unserved subscribed keys per contract (dashboard "missing instance" hints). */
  pendingByContract(): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    for (const record of this.contracts.values()) {
      if (record.pendingKeys.size > 0) out[record.contractId] = Array.from(record.pendingKeys)
    }
    return out
  }

  hasContract(contractId: string): boolean {
    return this.contracts.has(contractId)
  }
}
