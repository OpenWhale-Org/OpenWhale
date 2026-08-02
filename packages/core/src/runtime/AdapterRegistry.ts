import type { AdapterRegistration, AdapterResolver, NamespacedKind } from '../types/materialization.js'
import type { CredentialStore } from '../types/credential.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('AdapterRegistry')

const KEYLESS = '∅'

function cellKey(kind: NamespacedKind, type: string): string {
  return `${kind}::${type}`
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
  private readonly cells = new Map<string, { registration: AdapterRegistration; owner: string }>()
  /** Live instances keyed `${kind}::${type}::${credName | ∅}`. */
  private readonly cache = new Map<string, unknown>()

  constructor(private readonly credentials?: CredentialStore) {}

  register(owner: string, registration: AdapterRegistration): void {
    const key = cellKey(registration.kind, registration.type)
    const existing = this.cells.get(key)
    if (existing) {
      throw new Error(
        `Adapter cell (${registration.kind}, ${registration.type}) is already registered by plugin "${existing.owner}"`
      )
    }
    this.cells.set(key, { registration, owner })
  }

  /** Remove a plugin's cells and close their cached instances. */
  async unregisterOwner(owner: string): Promise<void> {
    for (const [key, cell] of this.cells) {
      if (cell.owner !== owner) continue
      this.cells.delete(key)
      for (const [cacheKey, instance] of this.cache) {
        if (!cacheKey.startsWith(`${key}::`)) continue
        this.cache.delete(cacheKey)
        await this.closeSafe(cacheKey, instance)
      }
    }
  }

  types(kind: NamespacedKind): string[] {
    return Array.from(this.cells.values())
      .filter(({ registration }) => registration.kind === kind)
      .map(({ registration }) => registration.type)
  }

  /** Every kind any cell claims — half of the derived kind vocabulary. */
  allKinds(): NamespacedKind[] {
    return Array.from(new Set(Array.from(this.cells.values()).map(({ registration }) => registration.kind)))
  }

  /** Kinds this credential type has cells for (its column set in the matrix). */
  kindsForType(type: string): NamespacedKind[] {
    return Array.from(this.cells.values())
      .filter(({ registration }) => registration.type === type)
      .map(({ registration }) => registration.kind)
  }

  /** The raw factory of a cell, for credentialed session construction outside the shared cache. */
  factoryFor(kind: NamespacedKind, type: string): AdapterRegistration['create'] | undefined {
    return this.cells.get(cellKey(kind, type))?.registration.create
  }

  has(kind: NamespacedKind, type: string): boolean {
    return this.cells.has(cellKey(kind, type))
  }

  async resolve<T = unknown>(kind: NamespacedKind, type: string, credentialName?: string): Promise<T> {
    const key = `${cellKey(kind, type)}::${credentialName ?? KEYLESS}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached as T

    const cell = this.cells.get(cellKey(kind, type))
    if (!cell) {
      throw new Error(
        `No adapter registered for kind "${kind}" type "${type}" — is the venue plugin loaded?`
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
      if (credType !== type) {
        throw new Error(
          `Credential "${credentialName}" has type "${credType}" but the adapter cell is (${kind}, ${type})`
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
