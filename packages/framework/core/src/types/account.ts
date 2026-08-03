import type { NamespacedKind } from './materialization.js'

/**
 * Account — the first-class entity of economic activity.
 *
 * Strategies READ accounts (through a structurally read-only view), executors
 * WRITE accounts (through the full body), and a credential is the key that
 * opens one. An account binds exactly ONE credential; one credential may back
 * any number of accounts.
 *
 * kind/type are derived — implementation registration supplies the kind (and
 * optionally pins the type), the bound credential supplies the concrete type.
 */
export interface AccountEntity {
  /** User-chosen unique name, e.g. 'BN-Main-Perp'. */
  name: string
  /** Registered implementation id ('<plugin>/<impl>'), e.g. 'exchange/perp-account'. */
  implementation: string
  /** Bound credential name. Absent = the account exists but is inactive. */
  credential?: string
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
  /** Venue specialization: restrict bindable credentials to this type. */
  type?: string
  /**
   * Build the structurally read-only view handed to strategies. The returned
   * object must expose NO write methods — that absence, not validation, is the
   * framework's safety guarantee.
   */
  createReader(session: unknown, accountName: string): unknown
}

/** Serializable implementation view (dashboard implementation picker). */
export interface AccountImplementationInfo {
  id: string
  displayName?: string
  kind: NamespacedKind
  type?: string
  pluginName: string
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
