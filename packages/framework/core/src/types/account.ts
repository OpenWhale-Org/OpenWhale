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
  displayName?: string
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
  label: string
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
  title: string
  kind: 'table' | 'keyvalue'
  columns?: AccountColumnDef[]
  /** Show the row count on the tab. */
  count?: boolean
  /** Open on this tab. */
  default?: boolean
  /** Text shown when the table is empty. */
  empty?: string
}

/** Resolve an implementation's venue pin, tolerating the legacy `type` spelling. */
export function implementationVenue(impl: Pick<AccountImplementation, 'venue' | 'type'>): string | undefined {
  return impl.venue ?? impl.type
}

/** Serializable implementation view (dashboard implementation picker). */
export interface AccountImplementationInfo {
  id: string
  displayName?: string
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
  /** Concrete credential type once a credential is bound. */
  type?: string
  /** 'inactive' until a credential is bound. */
  status: 'ready' | 'inactive' | 'broken'
  /** Populated when status is 'broken' (missing impl/credential, type mismatch). */
  problem?: string
  /** Last equity-snapshot failure (cleared on the next success) — surfaced on the Accounts page. */
  snapshotError?: string
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
