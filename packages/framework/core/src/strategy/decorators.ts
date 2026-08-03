import type { MonitorDeclaration, ExecutorDeclaration, LlmDeclaration } from '../types/strategy.js'
import type { AccountSlot, ReaderClass, NamespacedKind } from '../types/materialization.js'

/**
 * Declaration decorators — the runtime-only alternative to typed declarations.
 *
 * Two equivalent ways to declare a strategy's dependencies:
 *
 * 1. Typed declarations (labels autocomplete, account() returns the Reader type):
 *
 *    const decls = { accounts: [{ account: PerpAccount, label: 'main' }], ... }
 *      as const satisfies StrategyDeclarations
 *    class MyStrategy extends BaseStrategy<typeof decls> {
 *      override readonly accounts = decls.accounts
 *    }
 *
 * 2. Decorators (concise; labels are plain strings, account() is untyped —
 *    annotate the variable or cast when you need the Reader's methods):
 *
 *    @Strategy('my-strategy')
 *    @Monitor('trades', 'user-trades')
 *    @Executor('perp', 'exchange/perp-trading')
 *    @Account('main', PerpAccount)
 *    class MyStrategy extends BaseStrategy { ... }
 *
 * Class decorators cannot change the class's TYPE, so style 2 structurally
 * cannot offer label inference — that's the trade-off, not an omission.
 * Explicit field declarations always win over decorator metadata, so a
 * subclass can override a decorated base's declarations the usual way.
 *
 * Repeat a decorator once per slot. Decorators APPLY bottom-up (TC39 and
 * legacy alike), so each prepends — the resulting arrays follow source order,
 * which matters for positional (index-based) slot binding.
 */

export interface DecoratedDeclarations {
  id?: string
  monitors: MonitorDeclaration[]
  executors: ExecutorDeclaration[]
  accounts: AccountSlot[]
  llms: LlmDeclaration[]
}

// Keyed by the decorated constructor itself. A WeakMap (not context.metadata /
// static fields) so it works identically under TC39 and legacy decorators and
// never leaks across plugin copies of core: each copy resolves its own classes.
const registry = new WeakMap<object, DecoratedDeclarations>()

function entryFor(ctor: object): DecoratedDeclarations {
  let entry = registry.get(ctor)
  if (!entry) {
    entry = { monitors: [], executors: [], accounts: [], llms: [] }
    registry.set(ctor, entry)
  }
  return entry
}

// (value, context?) satisfies both decorator protocols: legacy passes just the
// constructor, TC39 passes (value, context). Both accept a void return.
type ClassDecorator = (value: object, context?: unknown) => void

/**
 * Declare the strategy id: `@Strategy('my-strategy')`.
 *
 * Equivalent to `readonly strategyId = 'my-strategy'`. The field form is a
 * compile-time obligation only when declared; a strategy that sets its id
 * neither way is rejected at registration, not at compilation.
 */
export function Strategy(id: string): ClassDecorator {
  return (value) => { entryFor(value).id = id }
}

/** Declare a monitor dependency: `@Monitor('trades', 'user-trades')`. `name` defaults to the label. */
export function Monitor(label: string, name: string = label): ClassDecorator {
  return (value) => { entryFor(value).monitors.unshift({ name, label }) }
}

/** Declare an executor dependency: `@Executor('perp', 'exchange/perp-trading')`. `name` defaults to the label. */
export function Executor(label: string, name: string = label): ClassDecorator {
  return (value) => { entryFor(value).executors.unshift({ name, label }) }
}

/**
 * Declare a named LLM slot: `@Llm('decision', 'anthropic:claude-sonnet-5')`.
 * Instances may override model/credential/settings per label.
 */
export function Llm(label: string, model: string, extra?: { credentialName?: string; settings?: Record<string, unknown> }): ClassDecorator {
  return (value) => { entryFor(value).llms.unshift({ label, model, ...extra }) }
}

/** Declare an account slot: `@Account('main', PerpAccount)`. */
export function Account(label: string, readerClass: ReaderClass): ClassDecorator {
  return (value) => { entryFor(value).accounts.unshift({ account: readerClass, label }) }
}

// ── Reader class decorators ───────────────────────────────────────────────────
//
// Unlike the strategy decorators above, these need no registry: the framework
// matches Reader classes by their STATIC properties, so the decorator just
// assigns them. Statics inherit through the prototype chain, so a venue
// subclass of a @Kind reader only needs @VenueType.

/**
 * Declare a Reader class's kind: `@Kind('exchange/perp')`.
 * Equivalent to `static readonly kind = 'exchange/perp' as const`.
 * A Reader declared in an account slot with the kind set neither way is
 * rejected when the strategy is registered.
 */
export function Kind(kind: NamespacedKind): ClassDecorator {
  return (value) => { (value as { kind?: NamespacedKind }).kind = kind }
}

/**
 * Pin a Reader class to one credential type: `@VenueType('binance')`.
 * Equivalent to `static readonly venueType = 'binance'`. Use on venue-specific
 * Reader subclasses; kind-level readers leave it unset to accept any venue.
 */
export function VenueType(type: string): ClassDecorator {
  return (value) => { (value as { venueType?: string }).venueType = type }
}

/**
 * Merge decorator-contributed declarations along the prototype chain,
 * base-most first (a subclass appends slots after its parents').
 * Returns undefined when no class in the chain was decorated.
 */
export function decoratedDeclarations(ctor: object): DecoratedDeclarations | undefined {
  const chain: DecoratedDeclarations[] = []
  for (let c = ctor; typeof c === 'function'; c = Object.getPrototypeOf(c) as object) {
    const entry = registry.get(c)
    if (entry) chain.unshift(entry)
  }
  if (chain.length === 0) return undefined
  // chain is base-first, so the most-derived @strategy(id) wins
  const id = chain.reduce<string | undefined>((acc, e) => e.id ?? acc, undefined)
  return {
    ...(id !== undefined ? { id } : {}),
    monitors: chain.flatMap(e => e.monitors),
    executors: chain.flatMap(e => e.executors),
    accounts: chain.flatMap(e => e.accounts),
    llms: chain.flatMap(e => e.llms),
  }
}
