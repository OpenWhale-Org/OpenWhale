import type { AdapterRegistration, AdapterResolver, NamespacedKind, NormalizedAdapterRegistration } from '../types/materialization.js'
import { cellVenue } from '../types/materialization.js'
import type { CredentialStore } from '../types/credential.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('AdapterRegistry')

const KEYLESS = '∅'

function cellKey(kind: NamespacedKind, venue: string): string {
  return `${kind}::${venue}`
}

/** Credential types a cell accepts — its own venue unless it names a shared key family. */
function accepted(reg: NormalizedAdapterRegistration): string[] {
  return reg.credentialTypes ?? [reg.venue]
}

/**
 * The runtime's adapter cell table + the AdapterResolver over it.
 *
 * Cells are registered by plugins (each remembers its owner so unload can
 * remove them); instances are created lazily, cached per
 * (kind, type, credentialName | keyless), and closed when their cell is
 * unregistered or the runtime stops. Credential data never leaves this class:
 * it is read, handed to the factory, and dropped.
 */
export class AdapterRegistry implements AdapterResolver {
  private readonly cells = new Map<string, { registration: NormalizedAdapterRegistration; owner: string }>()
  /** Live instances keyed `${kind}::${type}::${credName | ∅}`. */
  private readonly cache = new Map<string, unknown>()

  constructor(private readonly credentials?: CredentialStore) {}

  register(owner: string, registration: AdapterRegistration): void {
    const venue = cellVenue(registration)
    if (!venue) {
      throw new Error(`Plugin "${owner}": adapter cell for kind "${registration.kind}" declares neither venue nor (legacy) type`)
    }
    const key = cellKey(registration.kind, venue)
    const existing = this.cells.get(key)
    if (existing) {
      /* Says why a different namespace does not help, because that is the
         obvious next thing to try and it will fail the same way: cells are
         looked up by (kind, venue) — that IS the address a session is resolved
         through — so unlike a strategy there can only ever be one. */
      throw new Error(
        `Adapter cell (${registration.kind}, ${venue}) is already registered by plugin "${existing.owner}". ` +
          'Cells are addressed by (kind, venue) rather than by plugin namespace, so a venue can have exactly one ' +
          `provider for a kind — installing under another name will not help. Overwrite "${existing.owner}" if this ` +
          'is a new version of it, or uninstall it first.'
      )
    }
    this.cells.set(key, { registration: { ...registration, venue }, owner })
  }

  /** Which plugin holds this cell, if any — asked before an install, to say
   *  whether two plugins can coexist rather than finding out mid-registration. */
  ownerOfCell(kind: NamespacedKind, venue: string): string | undefined {
    return this.cells.get(cellKey(kind, venue))?.owner
  }

  /** Remove a plugin's cells and close their cached instances. */
  unregisterOwner(owner: string): Promise<void> {
    /* Every cell leaves the table BEFORE anything is awaited.
     *
     * Closing a live session is I/O and takes as long as it takes; which cells
     * exist is bookkeeping and must be true the instant this returns. Awaiting
     * inside the loop mixed the two: the first cell's session close suspended
     * the function with later cells still registered, so a replace — unload,
     * then immediately re-register — collided with the tail of the plugin it
     * had just unloaded, and reported the second cell as taken by the plugin
     * that was on its way out.
     */
    const closing: Array<Promise<void>> = []
    for (const [key, cell] of this.cells) {
      if (cell.owner !== owner) continue
      this.cells.delete(key)
      for (const [cacheKey, instance] of this.cache) {
        if (!cacheKey.startsWith(`${key}::`)) continue
        this.cache.delete(cacheKey)
        closing.push(this.closeSafe(cacheKey, instance))
      }
    }
    return Promise.all(closing).then(() => undefined)
  }

  /** Venues that registered a cell for this kind. */
  types(kind: NamespacedKind): string[] {
    return Array.from(this.cells.values())
      .filter(({ registration }) => registration.kind === kind)
      .map(({ registration }) => registration.venue)
  }

  /** Every kind any cell claims — half of the derived kind vocabulary. */
  allKinds(): NamespacedKind[] {
    return Array.from(new Set(Array.from(this.cells.values()).map(({ registration }) => registration.kind)))
  }

  /** Kinds this credential type can open (cells accepting it — its column set in the matrix). */
  kindsForType(type: string): NamespacedKind[] {
    return Array.from(this.cells.values())
      .filter(({ registration }) => accepted(registration).includes(type))
      .map(({ registration }) => registration.kind)
  }

  /**
   * Credential types the (kind, venue) cell accepts; undefined when no such
   * cell exists. The account-save and slot-binding validations key off this.
   */
  acceptedCredentialTypes(kind: NamespacedKind, venue: string): string[] | undefined {
    const cell = this.cells.get(cellKey(kind, venue))
    return cell ? accepted(cell.registration) : undefined
  }

  /** The raw factory of a cell, for credentialed session construction outside the shared cache. */
  factoryFor(kind: NamespacedKind, venue: string): AdapterRegistration['create'] | undefined {
    return this.cells.get(cellKey(kind, venue))?.registration.create
  }

  has(kind: NamespacedKind, venue: string): boolean {
    return this.cells.has(cellKey(kind, venue))
  }

  async resolve<T = unknown>(kind: NamespacedKind, venue: string, credentialName?: string): Promise<T> {
    const key = `${cellKey(kind, venue)}::${credentialName ?? KEYLESS}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached as T

    const cell = this.cells.get(cellKey(kind, venue))
    if (!cell) {
      throw new Error(
        `No adapter registered for kind "${kind}" venue "${venue}" — is the venue plugin loaded?`
      )
    }

    let instance: unknown
    if (credentialName === undefined) {
      instance = cell.registration.create()
    } else {
      if (!this.credentials) {
        throw new Error(`AdapterResolver has no CredentialStore — cannot resolve credential "${credentialName}"`)
      }
      const { type: credType, data } = await this.credentials.getByName(credentialName)
      const ok = accepted(cell.registration)
      if (!ok.includes(credType)) {
        throw new Error(
          `Credential "${credentialName}" has type "${credType}" but the (${kind}, ${venue}) cell accepts: ${ok.join(', ')}`
        )
      }
      instance = cell.registration.create(data)
    }
    this.cache.set(key, instance)
    return instance as T
  }

  /** Drop cached instances built from this credential (call when it changes/deletes). */
  async invalidateCredential(credentialName: string): Promise<void> {
    for (const [cacheKey, instance] of this.cache) {
      if (!cacheKey.endsWith(`::${credentialName}`)) continue
      this.cache.delete(cacheKey)
      await this.closeSafe(cacheKey, instance)
    }
  }

  async closeAll(): Promise<void> {
    for (const [cacheKey, instance] of this.cache) {
      await this.closeSafe(cacheKey, instance)
    }
    this.cache.clear()
  }

  private async closeSafe(key: string, instance: unknown): Promise<void> {
    try {
      await (instance as { close?: () => Promise<void> }).close?.()
    } catch (err) {
      log.warn({ adapter: key, err }, 'Adapter close failed — continuing')
    }
  }
}
