import type { ZodObject, ZodRawShape } from 'zod'
import type { RawCredentialData } from './credential.js'

/**
 * Credential materialization — the framework's core model.
 *
 * The Credential is the ONE root entity. Everything a consumer holds is a
 * materialization of a credential, on a privilege ladder:
 *
 *   Reader   read-only view        → injected into strategies   (lowest)
 *   Session  live venue connection → injected into executors
 *   Raw      decrypted data        → executors, explicit opt-in (e.g. bot tokens)
 *
 * Strategies can NEVER reach a session or raw data — not by validation, but
 * structurally: only readers are ever placed in their hands.
 *
 * ── Kinds ──────────────────────────────────────────────────────────────────
 * A `kind` names a session/reader contract pair (e.g. 'exchange/perp' →
 * PerpExchangeAdapter session + PerpAccount reader). Core defines NO kinds —
 * it is domain-clean. Domain packages (e.g. @openwhaleorg/exchange) introduce
 * kinds via declaration merging into AdapterKindMap and register the runtime
 * half (reader factory) through their plugin.
 *
 * Every kind id is namespaced ('ns/name'): the namespace owns the semantics,
 * collisions are impossible by construction, and there are no reserved words.
 *
 * ── type × kind matrix ─────────────────────────────────────────────────────
 * `type` classifies the credential ('binance'); `kind` belongs to the FACTORY.
 * One credential type may have factories for several kinds (a Binance key
 * opens both perp and spot sessions). A strategy demanding a kind accepts any
 * credential whose type has a factory for it — pick a credential, pick a venue.
 */

/**
 * Kind contract table. EMPTY in core — domain packages merge entries:
 *
 *   declare module '@openwhaleorg/core' {
 *     interface AdapterKindMap {
 *       'exchange/perp': { session: PerpExchangeAdapter; reader: PerpAccountReader }
 *     }
 *   }
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AdapterKindMap {}

/** Every kind id is namespaced — 'ns/name'. Enforced at type level and at plugin load. */
export type NamespacedKind = `${string}/${string}`

export type KnownKind = keyof AdapterKindMap & NamespacedKind

/** Session type for a kind (unknown for kinds not merged into the map). */
export type SessionOf<K> = K extends keyof AdapterKindMap
  ? AdapterKindMap[K] extends { session: infer S } ? S : unknown
  : unknown

/** Reader type for a kind. */
export type ReaderOf<K> = K extends keyof AdapterKindMap
  ? AdapterKindMap[K] extends { reader: infer R } ? R : unknown
  : unknown

/**
 * Constructor shape of a Reader class used in strategy account declarations.
 * The class carries serializable static metadata; the framework matches on
 * these strings only — NEVER instanceof (plugin bundles may duplicate classes).
 *
 * Set the metadata either as static fields or with the @Kind/@VenueType
 * decorators. `kind` is optional at the type level only because decorators
 * cannot change a class's type — a slot whose Reader has no kind is rejected
 * when the strategy is registered.
 */
export interface ReaderClass<T = unknown> {
  /** The kind whose sessions this reader wraps, e.g. 'exchange/perp'. */
  readonly kind?: NamespacedKind
  /** Set on venue-specific subclasses to pin the credential type. */
  readonly venueType?: string
  readonly prototype: T
}

/*
 * NOTE — kinds have NO runtime registration. A kind is:
 *   - type-level: an AdapterKindMap declaration-merging entry (the contract)
 *   - runtime: DERIVED vocabulary — a kind exists iff some adapter cell or
 *     account implementation claims it (listKinds() = union of both)
 * A domain package "registers" a kind by merging the type declaration,
 * contributing a (kind, 'mock') adapter cell (AI-compiler dry-runs), and a
 * kind-generic account implementation (the canonical read view).
 */

/**
 * A credential type — the registered recipe for one venue/service (n8n-style).
 * Declares how credentials of this type look (schema → auto-generated form),
 * which kinds they can materialize into (factories), and how to verify them.
 */
export interface CredentialTypeDefinition {
  /** Credential type id, e.g. 'binance', 'telegram'. */
  type: string
  displayName?: string
  /**
   * Brand mark for the picker: an https URL, or a `data:` URI to keep it
   * self-contained. A data URI is the better default — it survives offline,
   * cannot break when someone else's CDN moves, and asks nothing of the
   * operator's browser beyond the page they already loaded.
   *
   * The dashboard falls back to `icon`, then to the first letter of the name,
   * so this is always optional and a broken image never leaves a blank.
   */
  logo?: string
  /**
   * A single glyph for the picker — an emoji, or any one character. Used when
   * there is no logo. Optional in turn: a type with neither is drawn from the
   * first character of its name, so a plugin never has to invent artwork to
   * look complete.
   */
  icon?: string
  /** One line on what this credential is for, shown under the name. */
  description?: string
  /**
   * Which group the picker files this under. Defaults to the registering
   * plugin, which is the right answer for a venue — "binance" is both who
   * registered it and what it is. It is the wrong answer for the LLM types:
   * core registers them, but nobody looking for Anthropic thinks of it as
   * core's. Set this when the package is not the category.
   */
  category?: string
  documentationUrl?: string
  /** Field schema (Zod + .meta()) — drives the dashboard credential form. */
  schema?: ZodObject<ZodRawShape>
  /**
   * Session factories by kind — one row of the type × kind matrix.
   * Keys must be namespaced kind ids known to the runtime.
   */
  factories?: { [K in KnownKind]?: (data: RawCredentialData) => SessionOf<K> }
  /**
   * Venue-specific Reader overrides per kind (defaults to the kind's canonical
   * reader from its domain plugin). Lets a venue surface extra typed read methods.
   */
  readers?: { [K in KnownKind]?: (session: SessionOf<K>, credentialName: string) => ReaderOf<K> }
  /** Allow raw materialization (decrypted data handed to executors that opt in). */
  raw?: boolean
  /** Optional verification (dashboard "Test" button) — throw on failure. */
  test?: (data: RawCredentialData) => Promise<void>
}

/**
 * Serializable view of a CredentialTypeDefinition — what the dashboard (or any
 * remote client) needs to render a credential form and offer venue choices.
 * The Zod schema is exported as standard JSON Schema; `.meta()` extras
 * (displayName, password, placeholder, …) merge into each property.
 */
export interface CredentialTypeInfo {
  type: string
  displayName?: string
  /** Picker group; absent means "use pluginName". */
  category?: string
  /** Brand mark (URL or data: URI). Falls back to `icon`, then the first letter. */
  logo?: string
  /** Single glyph for the picker; absent means "derive one from the name". */
  icon?: string
  description?: string
  /** Registering plugin (the dashboard's picker groups by this); built-ins are 'core'. */
  pluginName: string
  documentationUrl?: string
  /** Kinds this type can materialize into (factory keys). */
  kinds: NamespacedKind[]
  raw?: boolean
  /** True when the definition ships a test() connectivity probe. */
  hasTest: boolean
  /** JSON Schema (draft 2020-12) derived from the Zod field schema. */
  jsonSchema?: Record<string, unknown>
}

/**
 * One cell of the type × kind matrix: the implementation recipe for kind K on
 * credential type T. A single factory whose `data` is OPTIONAL — whether a
 * credential is supplied is the CALLER's declaration; whether the keyless
 * form is viable is the implementation's own validation. Which class backs
 * the keyless form (e.g. a public ccxt adapter vs the venue's native one) is
 * an internal detail of the factory, invisible to every consumer.
 *
 * Adapters are NOT a consumer-facing concept: components declare
 * (kind, type, credential need) and obtain instances only through the
 * AdapterResolver. Registration is the plugin's `adapters` array.
 */
export interface AdapterRegistration {
  kind: NamespacedKind
  /**
   * Cell identity — the venue this cell trades/reads on, e.g. 'binance',
   * 'uniswap', 'evm'. Exactly one of `venue`/`type` must be set; `venue` wins.
   */
  venue?: string
  /** @deprecated Legacy name for {@link venue}. Kept so existing cells load unchanged. */
  type?: string
  /**
   * Credential types this cell accepts. Defaults to `[venue]` — the CEX case,
   * where the venue issues its own key. On-chain venues list a shared key
   * family instead (e.g. `['web3/evm']`): one wallet key opens many venues.
   */
  credentialTypes?: string[]
  create: (data?: RawCredentialData) => unknown
}

/** A cell after load-time normalization: `venue` resolved, legacy `type` folded in. */
export interface NormalizedAdapterRegistration extends AdapterRegistration {
  venue: string
}

/** Resolve a registration's cell identity (venue), tolerating the legacy `type` spelling. */
export function cellVenue(reg: Pick<AdapterRegistration, 'venue' | 'type'>): string | undefined {
  return reg.venue ?? reg.type
}

/**
 * The single gateway to adapter instances. Caches one live session per
 * (kind, type, credentialName | keyless) and closes them on runtime stop /
 * plugin unload. Consumers never construct adapters themselves.
 */
export interface AdapterResolver {
  /** Venues that registered a cell for this kind. */
  types(kind: NamespacedKind): string[]
  /** Whether a cell exists for (kind, venue). */
  has(kind: NamespacedKind, venue: string): boolean
  /**
   * Resolve the shared adapter instance for a cell. With `credentialName`,
   * the credential is read, its type checked for membership in the cell's
   * accepted `credentialTypes` (default: the venue itself), and its data
   * passed to the factory; without it, the keyless form is built.
   */
  resolve<T = unknown>(kind: NamespacedKind, venue: string, credentialName?: string): Promise<T>
}

/**
 * A plugin-registered factory for a credential-less, read-only session of a
 * kind — public market data (tickers, funding rates, klines) that requires no
 * API key. The registering plugin's name is the venue. Shared: the runtime
 * creates at most one public session per (venue, kind) and closes it on stop.
 *
 * @deprecated Superseded by {@link AdapterRegistration} (the keyless form of a
 * cell). Entries are converted to cells at load; remove once venue plugins
 * migrate to `adapters`.
 */
export interface PublicSessionRegistration {
  kind: NamespacedKind
  create: () => unknown
}

/**
 * Late-bound view of the public session registry, handed to plugin factories.
 * Query at use time, not at load time — venue plugins may register their
 * public sessions after the consuming (domain) plugin has loaded.
 */
export interface PublicSessionAccessor {
  /** Venues (plugin names) that registered a public session for this kind. */
  venues(kind: NamespacedKind): string[]
  /** The shared public session for venue+kind, created lazily on first use. */
  get<T = unknown>(venue: string, kind: NamespacedKind): Promise<T>
}

/** A session must expose close() so the runtime can release venue connections. */
export interface ISession {
  close?(): Promise<void>
}

/** Strategy-side account slot: a Reader class reference plus a local label. */
export interface AccountSlot<C extends ReaderClass = ReaderClass> {
  account: C
  label: string
}

/**
 * Executor-side credential slots — sessions by kind, or raw data by explicit
 * opt-in. `optional: true` lets activation proceed with the slot unbound; the
 * executor must then handle instructions without it (side-channel executors
 * like notifiers, gated by a strategy toggle).
 */
export type ExecutorCredentialSlot =
  | { label: string; kind: NamespacedKind; type?: string; optional?: true }
  | { label: string; type: string; raw: true; optional?: true }
