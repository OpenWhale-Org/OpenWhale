import type { Text } from '../i18n.js'
import type { ZodObject, ZodRawShape } from 'zod'
import type { NamespacedKind } from './materialization.js'

/**
 * Account — the first-class entity of economic activity.
 *
 * Strategies READ accounts (through a structurally read-only view), executors
 * WRITE accounts (through the full body), and a credential is the key that
 * opens one. An account binds exactly ONE credential; one credential may back
 * any number of accounts.
 *
 * kind/venue are derived — implementation registration supplies the kind (and
 * optionally pins the venue), the bound credential supplies the concrete
 * credential type.
 */
export interface AccountEntity {
  /** User-chosen unique name, e.g. 'BN-Main-Perp'. */
  name: string
  /** Registered implementation id ('<plugin>/<impl>'), e.g. 'exchange/perp-account'. */
  implementation: string
  /** Bound credential name. Absent = the account exists but is inactive. */
  credential?: string
  /**
   * Implementation-declared configuration (validated against the
   * implementation's paramsSchema). "How to view this key" — e.g. which
   * chains a wallet account aggregates. Editable in place: accounts have no
   * activation lifecycle, a change simply rebuilds the read view.
   */
  params?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

/**
 * A registered account implementation — one row of the specialization ladder:
 * kind-generic (exchange registers 'exchange/perp-account' for any perp venue)
 * or (kind, type)-specialized (a venue package registers its own). Multiple
 * plugins specializing the same type never collide: ids are plugin-qualified
 * and the user picks an implementation explicitly at account creation.
 */
export interface AccountImplementation {
  /** Short id; qualified to '<plugin>/<id>' at load. */
  id: string
  displayName?: Text
  /** The kind this implementation's accounts expose. */
  kind: NamespacedKind
  /**
   * Venue specialization: pin this implementation to one (kind, venue) cell.
   * Bindable credentials are whatever that cell accepts (its credentialTypes,
   * default the venue itself). Unset = kind-generic (any venue of the kind,
   * cell chosen by the bound credential's type).
   */
  venue?: string
  /** @deprecated Legacy name for {@link venue}. */
  type?: string
  /**
   * Declared configuration schema (Zod object). Drives the account form on
   * the dashboard; values are validated on save and handed to createReader.
   */
  paramsSchema?: ZodObject<ZodRawShape>
  /** Declarative detail panel (see AccountSectionDef). */
  sections?: AccountSectionDef[]
  /**
   * The writes this implementation offers (see AccountActionDef). Absent =
   * read-only, which stays the default: a kind gains a write surface only by
   * declaring one.
   */
  actions?: AccountActionDef[]
  /**
   * Build the WRITE view — an object with one method per declared action.
   *
   * Deliberately a second constructor rather than methods on the reader: the
   * reader's lack of write methods is the framework's safety guarantee, and
   * only the operator action route ever calls this. A kind can therefore gain
   * a write surface without widening what a strategy can reach.
   */
  createWriter?(session: unknown, accountName: string, params?: Record<string, unknown>): unknown
  /** Brand mark for pickers (https URL or data: URI); `icon` is the emoji fallback. */
  logo?: string
  icon?: string
  /**
   * Build the structurally read-only view handed to strategies. The returned
   * object must expose NO write methods — that absence, not validation, is the
   * framework's safety guarantee.
   */
  createReader(session: unknown, accountName: string, params?: Record<string, unknown>): unknown
}

/**
 * Declarative detail panel — what the Accounts page shows for accounts of
 * this implementation, without the dashboard knowing the kind. Each section
 * names a READ METHOD on the reader; the runtime calls it and ships the
 * result with this layout, the dashboard renders by column format. Kinds
 * without a declaration fall back to the perp/spot convention
 * (balance / positions / orders).
 */
export type AccountColumnFormat = 'text' | 'mono' | 'number' | 'usd' | 'pct' | 'signed' | 'side' | 'time' | 'badge'

export interface AccountColumnDef {
  /** Field on each row. */
  key: string
  label: Text
  format?: AccountColumnFormat
  /** Decimal places for number/usd/pct/signed. */
  digits?: number
  align?: 'left' | 'right'
  /** Grows to take the remaining width (one per table). */
  grow?: boolean
}

export interface AccountSectionDef {
  /** Reader method to call — must return rows (table) or an object (keyvalue). */
  method: string
  title: Text
  kind: 'table' | 'keyvalue'
  columns?: AccountColumnDef[]
  /** Show the row count on the tab. */
  count?: boolean
  /** Open on this tab. */
  default?: boolean
  /** Text shown when the table is empty. */
  empty?: string
}

/**
 * One operator-invokable write on an account — the write half of the
 * declarative panel, mirroring AccountSectionDef on the read half.
 *
 * Declaring an action is all the dashboard needs: `paramsSchema` becomes the
 * form (the same derivation strategy, monitor and script params use), and the
 * handler is the writer method named by `id`. The page never learns the kind.
 *
 * This is an OPERATOR surface, not a strategy one. Strategy order flow still
 * travels instruction → queue → executor; these run on a human click, and the
 * runtime records every one to the executions log so a manual order is as
 * auditable as an automated one.
 */
export interface AccountActionDef {
  /** Unique within the implementation; also the writer's method name. */
  id: string
  displayName: Text
  description?: Text
  /** Section header in the action list, e.g. 'Order' / 'Position' / 'Margin'. */
  group?: Text
  /**
   * Moves money or cannot be undone. The dashboard colours it as dangerous and
   * requires a second, explicit confirmation naming the account before sending.
   */
  danger?: boolean
  /** Label for the submit button; defaults to the action's display name. */
  submitLabel?: Text
  /** Params form; validated server-side before the writer is called. */
  paramsSchema?: ZodObject<ZodRawShape>
  /**
   * Live-resolved select options keyed by param name — open order ids, held
   * symbols, the venue catalogue. Resolved per listing so a dropdown always
   * reflects the account as it is now; a resolver failure costs only the
   * dropdown, which degrades to a plain input.
   */
  paramOptions?(ctx: AccountActionOptionsContext): Promise<Record<string, import('./definition.js').ParamFieldOption[]>>
}

export interface AccountActionOptionsContext {
  /** The account's venue session — the same object the reader wraps. */
  session: unknown
  account: string
  /** The account's declared configuration, as stored on the entity. */
  params?: Record<string, unknown>
}

/** Serializable action view (dashboard account write panel). */
export interface AccountActionInfo {
  id: string
  displayName: Text
  description?: Text
  group?: Text
  danger?: boolean
  submitLabel?: Text
  paramsFields?: import('./definition.js').ParamFieldDef[]
}

/**
 * One recorded operator write, appended to the executions log under the
 * synthetic executor name `account-actions`.
 *
 * Deliberately shaped like an ExecutionResult, down to the `instruction`
 * envelope: the Executions page already renders that shape, so a manual order
 * reads there exactly like an automated one instead of as a row of dashes. The
 * point of writing it down at all is that "who moved this position?" has one
 * place to look, and a second format with its own viewer defeats that.
 *
 * What identifies it as manual: `executorId` is `account-actions`, there is no
 * `instanceId` or `runId` (no instance and no run decided it), and `actor`
 * names the operator who clicked.
 */
export interface AccountActionRecord {
  instruction: {
    action: string
    /** Always 'account-actions' — the synthetic executor these are filed under. */
    executorId: string
    /** As validated, before the writer ran. */
    params: Record<string, unknown>
    /** The one account written to, so the page's account filter finds it. */
    accountNames: string[]
    /** Operator who invoked it, when the gateway knows one. */
    actor?: string
    /** Which implementation's writer ran — the audit's "by what code". */
    implementation: string
  }
  status: 'success' | 'failed'
  /** Whatever the writer returned (order id, venue payload). */
  data?: unknown
  error?: string
  executedAt: string
}

/** Resolve an implementation's venue pin, tolerating the legacy `type` spelling. */
export function implementationVenue(impl: Pick<AccountImplementation, 'venue' | 'type'>): string | undefined {
  return impl.venue ?? impl.type
}

/** Serializable implementation view (dashboard implementation picker). */
export interface AccountImplementationInfo {
  id: string
  displayName?: Text
  kind: NamespacedKind
  /** Venue pin (legacy field name kept for the dashboard wire format). */
  type?: string
  /** Credential types the pinned (kind, venue) cell accepts — the form's eligibility list. */
  credentialTypes?: string[]
  pluginName: string
  logo?: string
  icon?: string
  /** Schema-derived form fields (same shape monitor-instance params use). */
  paramsFields?: import('./definition.js').ParamFieldDef[]
}

/** Serializable account view with derived facts (dashboard Accounts page). */
export interface AccountView extends AccountEntity {
  kind?: NamespacedKind
  /**
   * Concrete credential type once a credential is bound.
   *
   * NOT the venue, though on a CEX the two coincide — a Boros account binds a
   * `pendle/boros-agent` credential and trades on `boros`. Anything asking
   * "which venue?" (catalogue pickers, adapter lookups) wants `venue` below;
   * this answers "which secret?".
   */
  type?: string
  /**
   * The venue this account is on: the implementation's pin, or for a
   * kind-generic implementation the bound credential's type — the rule the
   * binding resolver applies. Absent only while no credential is bound to a
   * kind-generic implementation, when there is no venue to name yet.
   */
  venue?: string
  /** 'inactive' until a credential is bound. */
  status: 'ready' | 'inactive' | 'broken'
  /** Populated when status is 'broken' (missing impl/credential, type mismatch). */
  problem?: string
  /** Last equity-snapshot failure (cleared on the next success) — surfaced on the Accounts page. */
  snapshotError?: string
  /** The implementation declares actions — the dashboard offers the Trade tab. */
  writable?: boolean
}

export interface AccountStore {
  save(entity: AccountEntity): Promise<void>
  get(name: string): Promise<AccountEntity | null>
  list(): Promise<AccountEntity[]>
  delete(name: string): Promise<void>
}

/**
 * Point-in-time equity sample of an account.
 *
 * Read-view convention: an account read view MAY implement
 * `snapshot(): Promise<AccountSnapshotSample>` — equity is a READ, so the
 * capability lives on the read view (domain packages define what "equity"
 * means; core only schedules and stores). Views without it are skipped.
 */
export interface AccountSnapshotSample {
  /** Account value in USD (domain-defined; perp = collateral + unrealized PnL). */
  equity: number
  available?: number
  unrealizedPnl?: number
}

export interface AccountSnapshotRecord extends AccountSnapshotSample {
  account: string
  /** Sample time (epoch ms). */
  ts: number
}

export interface AccountSnapshotStore {
  append(record: AccountSnapshotRecord): Promise<void>
  /** Ascending-time series for one account since `sinceTs` (epoch ms). */
  series(account: string, sinceTs: number): Promise<AccountSnapshotRecord[]>
  /** The most recent record per account. */
  latest(): Promise<AccountSnapshotRecord[]>
  /** Drop one account's whole history (bad-recipe samples, account retirement). */
  clear(account: string): Promise<void>
  prune(beforeTs: number): Promise<void>
}
