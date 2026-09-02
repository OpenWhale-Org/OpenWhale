import type { OpenWhalePlugin, PluginFactory } from './PluginManager.js'
import type { CredentialTypeDefinition, AdapterRegistration } from '../types/materialization.js'
import type { AccountImplementation } from '../types/account.js'
import type { MonitorImplementation } from '../types/monitorInstance.js'
import type { IStrategy } from '../types/strategy.js'
import type { ScriptDefinition } from '../types/script.js'
import type { BaseExecutor } from '../executor/BaseExecutor.js'
import {
  owMonitorMeta, owAccountMeta, owExecutorMeta, owStrategyMeta,
  type MonitorClass, type AccountClass,
} from './componentDecorators.js'

/**
 * The plugin manifest — a thin, declarative list. Classes carry their own
 * metadata via the @Ow* decorators; non-class elements (adapter cells,
 * credential types) stay plain objects. Everything optional: the field set IS
 * the plugin's identity (venue = credentialTypes + adapters; data source =
 * credentialTypes + specialized monitors; domain package = mock cells +
 * generic implementations; strategy package = behavior components).
 *
 * Kinds have no field: the vocabulary is derived from the matrix.
 *
 * definePlugin() lowers the manifest into the runtime plugin shape. It stays
 * a pure function of its input — no registration happens here.
 */
export interface PluginManifest {
  name: string
  version: string
  /** Markdown README shown on the dashboard's Plugins page. */
  readme?: string
  /** Brand mark for the plugin list (https URL or data: URI). */
  logo?: string
  /** Single-glyph fallback mark. */
  icon?: string
  credentialTypes?: CredentialTypeDefinition[]
  adapters?: AdapterRegistration[]
  /** @OwAccount classes or plain registrations. */
  accounts?: Array<AccountClass | AccountImplementation>
  /** @OwMonitor classes or plain registrations. */
  monitors?: Array<MonitorClass | MonitorImplementation>
  /** @OwExecutor classes (zero-arg constructor). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  executors?: Array<new () => BaseExecutor<any>>
  /** Strategy classes (zero-arg constructor; id from the class or @Strategy). */
  strategies?: Array<new () => IStrategy>
  /**
   * Operator utilities for the dashboard's Scripts page — run on click, no
   * lifecycle. Passed through verbatim: a script is already a plain object,
   * so there is nothing to lower.
   */
  scripts?: ScriptDefinition[]
}

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

function isClass(value: unknown): value is new (...args: never[]) => unknown {
  return typeof value === 'function'
}

/**
 * Lower an account entry (a plain registration, or an @OwAccount class) into
 * the runtime registration shape. Shared by definePlugin AND loadPlugin, so
 * plugin factories may reference classes directly in their `accounts` array.
 */
export function lowerAccountEntry(entry: AccountClass | AccountImplementation, pluginName: string): AccountImplementation {
  if (!isClass(entry)) return entry
  const meta = owAccountMeta(entry)
  if (!meta) throw new Error(`Plugin "${pluginName}": account class ${entry.name} has no @OwAccount metadata`)
  const venue = meta.venue ?? meta.type
  return {
    id: meta.id ?? kebab(entry.name),
    kind: meta.kind,
    ...(venue !== undefined ? { venue } : {}),
    ...(meta.displayName !== undefined ? { displayName: meta.displayName } : {}),
    ...(meta.paramsSchema !== undefined ? { paramsSchema: meta.paramsSchema } : {}),
    ...(meta.sections !== undefined ? { sections: meta.sections } : {}),
    ...(meta.logo !== undefined ? { logo: meta.logo } : {}),
    ...(meta.icon !== undefined ? { icon: meta.icon } : {}),
    createReader: (session, accountName, params) => new entry(accountName, session as never, params),
  }
}

/** Lower a monitor entry (plain registration or @OwMonitor class) — see lowerAccountEntry. */
export function lowerMonitorEntry(entry: MonitorClass | MonitorImplementation, pluginName: string): MonitorImplementation {
  if (!isClass(entry)) return entry as MonitorImplementation
  const meta = owMonitorMeta(entry)
  if (!meta) throw new Error(`Plugin "${pluginName}": monitor class ${entry.name} has no @OwMonitor metadata`)
  return {
    id: meta.id,
    contract: meta.contract ?? meta.id,
    ...(meta.name !== undefined ? { displayName: meta.name } : {}),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.credential !== undefined ? { credential: meta.credential } : {}),
    ...(meta.venue !== undefined ? { venue: meta.venue } : {}),
    ...(meta.params !== undefined ? { params: meta.params } : {}),
    create: (ctx) => new (entry as MonitorClass)(ctx),
  }
}

/** Lower a manifest into a PluginFactory (the shape loadPlugin consumes). */
export function definePlugin(manifest: PluginManifest): PluginFactory<Record<string, unknown>> {
  return (): OpenWhalePlugin => {
    const now = new Date().toISOString()

    const accounts = (manifest.accounts ?? []).map((entry) => lowerAccountEntry(entry, manifest.name))
    const monitorImplementations = (manifest.monitors ?? []).map((entry) => lowerMonitorEntry(entry, manifest.name))

    const executors = (manifest.executors ?? []).map((Ctor) => {
      const meta = owExecutorMeta(Ctor) ?? {}
      const instance = new Ctor()
      const id = meta.id ?? instance.executorName
      return {
        definition: {
          id,
          name: meta.name ?? id,
          ...(meta.description !== undefined ? { description: meta.description } : {}),
          source: 'plugin' as const,
          pluginName: manifest.name,
          supportedActions: [...instance.supportedActions],
          createdAt: now,
          updatedAt: now,
        },
        instance,
      }
    })

    const strategies = (manifest.strategies ?? []).map((Ctor) => {
      const meta = owStrategyMeta(Ctor) ?? {}
      const probe = new Ctor()
      const id = meta.id ?? probe.strategyId
      if (!id) {
        throw new Error(
          `Plugin "${manifest.name}": strategy class ${Ctor.name} has no id — set strategyId, @Strategy('...'), or @OwStrategy({ id })`
        )
      }
      return {
        definition: {
          id,
          name: meta.name ?? id,
          ...(meta.description !== undefined ? { description: meta.description } : {}),
          source: 'plugin' as const,
          pluginName: manifest.name,
          createdAt: now,
          updatedAt: now,
        },
        factory: () => new Ctor(),
      }
    })

    return {
      name: manifest.name,
      version: manifest.version,
      ...(manifest.readme !== undefined ? { readme: manifest.readme } : {}),
      ...(manifest.logo !== undefined ? { logo: manifest.logo } : {}),
      ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
      ...(manifest.credentialTypes ? { credentialTypes: manifest.credentialTypes } : {}),
      ...(manifest.scripts ? { scripts: manifest.scripts } : {}),
      ...(manifest.adapters ? { adapters: manifest.adapters } : {}),
      ...(accounts.length ? { accounts } : {}),
      ...(monitorImplementations.length ? { monitorImplementations } : {}),
      ...(executors.length ? { executors } : {}),
      ...(strategies.length ? { strategies } : {}),
    }
  }
}
