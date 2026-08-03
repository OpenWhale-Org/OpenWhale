import { z } from 'zod'
import { BaseMonitor, MonitorMode, createLogger } from '@openwhaleorg/core'
import type { AdapterResolver, MonitorContext } from '@openwhaleorg/core'
import type { PerpExchangeAdapter } from '../types/perp.js'

/**
 * Shared machinery for venue-agnostic market-data monitors.
 *
 * Every subclass is keyed `venue:symbol[:extra]` and runs one independent
 * feed per key over that venue's PUBLIC session — market data needs no
 * credential, so a strategy can watch any venue the runtime has a plugin for
 * without the user storing an API key.
 *
 * The base owns the parts that are identical everywhere: key parsing, session
 * acquisition, per-key lifecycle tied to subscribe/unsubscribe, and restarting
 * a feed that dies (venues drop websockets routinely) with capped backoff.
 * Subclasses implement `feed()` — one key's data loop — and are handed an
 * `emit` callback plus the AbortSignal that ends it.
 */
export abstract class PublicMarketMonitor<TData> extends BaseMonitor<string, TData> {
  override readonly mode = MonitorMode.Subscribe

  protected readonly adapters: AdapterResolver
  private readonly feeds = new Map<string, AbortController>()

  constructor(ctx: MonitorContext) {
    super(ctx?.dataDir !== undefined ? { dataDir: ctx.dataDir } : undefined)
    if (!ctx?.adapters) {
      // Pointed error for plugins built against the v1 API: the options-object
      // constructor ({ publicSessions, … }) died in the contract/implementation/
      // instance redesign — sessions now resolve through ctx.adapters.
      throw new Error(
        `${this.constructor.name}: MonitorContext.adapters missing — monitors receive (ctx: MonitorContext) ` +
        'since the v2 plugin architecture; the { publicSessions, … } options constructor is gone. ' +
        'Rebuild the plugin against the current @openwhaleorg/exchange.'
      )
    }
    this.adapters = ctx.adapters
  }

  private get logger() { return createLogger(this.monitorName) }

  /**
   * Shape of this monitor's subscribe keys:
   *   'venue'         'binance'                     — venue-wide feeds
   *   'symbol'        'binance:BTC/USDT:USDT'       — one contract (default)
   *   'symbol+extra'  'binance:BTC/USDT:USDT:1m'    — one contract plus a qualifier
   *
   * Explicit because ccxt perp symbols contain colons themselves, so the
   * split cannot be inferred from the key alone.
   */
  protected get keyShape(): MarketKeyShape { return 'symbol' }

  /**
   * Venue field for key schemas — offered as a dropdown of the venues (types)
   * that registered an 'exchange/perp' adapter cell (queried live, so schemas
   * derived after plugin load see the full list).
   */
  protected venueField() {
    // 'mock' is the AI compiler's dry-run column — real watches never want it
    const venues = this.adapters.types('exchange/perp').filter(v => v !== 'mock')
    return z.string().min(1).meta({
      displayName: 'Venue',
      placeholder: 'binance',
      description: 'venue plugin with an exchange/perp adapter',
      ...(venues.length > 0 ? { options: venues.map(v => ({ label: v, value: v })) } : {}),
    })
  }

  protected symbolField() {
    return z.string().min(1).meta({
      displayName: 'Symbol',
      placeholder: 'BTC/USDT:USDT',
      description: 'ccxt symbol (perp symbols include the settle currency)',
      // Offers the venue's listed markets in a searchable picker. Free text
      // still works — an unlisted symbol or a venue with no catalogue must
      // not block the form.
      catalogue: { source: 'market', venueField: 'venue', kind: 'exchange/perp', marketType: 'swap' },
    })
  }

  /** Derived from keyShape; 'symbol+extra' monitors declare their own. */
  override get keySchema() {
    if (this.keyShape === 'venue') return z.object({ venue: this.venueField() })
    if (this.keyShape === 'symbol') return z.object({ venue: this.venueField(), symbol: this.symbolField() })
    return undefined
  }

  /**
   * One key's data loop. Runs until `signal` aborts; throwing (or returning)
   * early triggers a backoff restart while the key stays subscribed.
   */
  protected abstract feed(
    parsed: ParsedMarketKey,
    session: PerpExchangeAdapter,
    emit: (data: TData) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>

  protected override startSubscribe(key: string): void {
    if (this.feeds.has(key)) return
    const controller = new AbortController()
    this.feeds.set(key, controller)
    void this.runFeed(key, controller.signal)
  }

  protected override stopSubscribe(key: string): void {
    this.feeds.get(key)?.abort()
    this.feeds.delete(key)
  }

  private async runFeed(key: string, signal: AbortSignal): Promise<void> {
    const parsed = parseMarketKey(key, this.keyShape)
    if (!parsed) {
      this.logger.error({ key }, 'Invalid monitor key — see the monitor description for the expected format')
      return
    }

    // Serialize emits per key: push() persists before dispatching, and two
    // in-flight pushes can otherwise land out of order — a strategy must never
    // see an older price after a newer one.
    let chain: Promise<void> = Promise.resolve()
    const emit = (data: TData): Promise<void> => {
      chain = chain.then(() => this.push(key, data))
      return chain
    }
    let attempt = 0

    while (!signal.aborted) {
      try {
        const session = await this.adapters.resolve<PerpExchangeAdapter>('exchange/perp', parsed.venue)
        await this.feed(parsed, session, emit, signal)
        attempt = 0   // a clean return means the venue closed the stream — reconnect promptly
      } catch (err) {
        if (signal.aborted) return
        attempt++
        this.logger.warn({ key, attempt, err }, 'Market feed failed — restarting after backoff')
      }
      if (signal.aborted) return
      await sleep(Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000), signal)
    }
  }
}

export type MarketKeyShape = 'venue' | 'symbol' | 'symbol+extra'

export interface ParsedMarketKey {
  venue: string
  /** Empty string for venue-wide feeds, which have no symbol segment. */
  symbol: string
  /** Trailing qualifier, e.g. the timeframe in 'binance:BTC/USDT:USDT:1m'. */
  extra?: string
}

/**
 * Parse a subscribe key according to the monitor's declared shape.
 *
 * The ambiguity this resolves: ccxt perp symbols contain colons
 * ('BTC/USDT:USDT'), so which segments belong to the symbol depends on
 * whether the monitor takes a trailing qualifier — it cannot be guessed.
 */
export function parseMarketKey(key: string, shape: MarketKeyShape = 'symbol'): ParsedMarketKey | undefined {
  const parts = key.split(':')
  const venue = parts[0]!
  if (!venue) return undefined

  if (shape === 'venue') {
    return parts.length === 1 ? { venue, symbol: '' } : undefined
  }
  if (parts.length < 2) return undefined

  if (shape === 'symbol+extra') {
    if (parts.length < 3) return undefined
    const extra = parts[parts.length - 1]!
    const symbol = parts.slice(1, -1).join(':')
    return symbol ? { venue, symbol, extra } : undefined
  }
  const symbol = parts.slice(1).join(':')
  return symbol ? { venue, symbol } : undefined
}

/** Abortable sleep — never leaves a timer pending after unsubscribe. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
  })
}
