import fs from 'fs'
import path from 'path'
import type { EmitHandler, MonitorDataReader, MonitorOptions, MonitorPlotDef } from '../types/monitor.js'
import type { ZodObject, ZodRawShape } from 'zod'
import { getDataDir, getMonitorPath } from '../utils/paths.js'
import { MonitorDataReaderImpl } from './MonitorDataReader.js'
import { createLogger } from '../utils/logger.js'

/**
 * Standalone — can only run independently; does not support subscribe-driven mode
 * Subscribe  — can only be driven by subscribe; does not support standalone mode
 * Any        — supports both modes
 *
 * SEALED (2026-07 ruling): Standalone/Any are deprecated and will be removed
 * with the legacy registration path. Scan-the-whole-venue monitors are
 * Subscribe with key = venue — content inside a key is self-discovering, which
 * covers Standalone's real use. Casualties recorded for the removal sweep:
 * `key: '*'` trigger sources and subscribeAll() (only legal on Standalone/Any).
 */
export enum MonitorMode {
  /** @deprecated Sealed — migrate to Subscribe with key = venue. */
  Standalone = 'standalone',
  Subscribe = 'subscribe',
  /** @deprecated Sealed — migrate to Subscribe. */
  Any = 'any',
}

/**
 * @ai-guide How to write a Monitor
 *
 * 1. Choose a run mode:
 *    - MonitorMode.Subscribe: data is driven by external keys (e.g. REST polling); override startSubscribe/stopSubscribe
 *    - MonitorMode.Standalone: monitor manages its own connection (e.g. WebSocket); override startStandalone/stopStandalone
 *    - MonitorMode.Any: supports both modes; override all four methods
 *
 * 2. Define generic parameters:
 *    - TKey: the key type being monitored, typically a trading pair, address, or string identifier
 *    - TData: the data structure collected each time; no need to include a timestamp (base class injects ts automatically)
 *
 * 3. Implement monitorName: return a unique string name used to determine the JSONL file storage path
 *
 * 4. In startSubscribe(key) / startStandalone(), start collection.
 *    Call this.push(key, data) each time new data is available to submit to the base class.
 *
 * 5. In stopSubscribe(key) / stopStandalone(), clean up resources (clearInterval, close connections, etc.)
 *
 * Subscribe mode example (REST polling):
 * ```typescript
 * class PriceMonitor extends BaseMonitor<string, { price: number }> {
 *   readonly mode = MonitorMode.Subscribe
 *   get monitorName() { return 'price' }
 *   private timers = new Map<string, NodeJS.Timeout>()
 *
 *   protected startSubscribe(key: string) {
 *     const t = setInterval(async () => {
 *       const price = await fetchPrice(key)
 *       await this.push(key, { price })
 *     }, 5000)
 *     this.timers.set(key, t)
 *   }
 *   protected stopSubscribe(key: string) {
 *     clearInterval(this.timers.get(key))
 *     this.timers.delete(key)
 *   }
 * }
 * ```
 *
 * Subscribe mode example (single WebSocket connection, subscribe/unsubscribe per key):
 * ```typescript
 * class TradeMonitor extends BaseMonitor<string, TradeData> {
 *   readonly mode = MonitorMode.Subscribe
 *   get monitorName() { return 'trade' }
 *   private ws?: WebSocket
 *   private subscribedKeys = new Set<string>()
 *
 *   // Ensure WS connection exists; establish on first call
 *   private ensureConnected() {
 *     if (this.ws) return
 *     this.ws = new WebSocket('wss://exchange/stream')
 *     this.ws.on('message', (raw) => {
 *       const { key, ...data } = JSON.parse(raw.toString())
 *       if (this.subscribedKeys.has(key)) void this.push(key, data)
 *     })
 *     this.ws.on('open', () => {
 *       // Re-subscribe all keys after reconnect
 *       for (const key of this.subscribedKeys) this.sendSubscribe(key)
 *     })
 *   }
 *
 *   private sendSubscribe(key: string) {
 *     this.ws?.send(JSON.stringify({ op: 'subscribe', channel: key }))
 *   }
 *
 *   private sendUnsubscribe(key: string) {
 *     this.ws?.send(JSON.stringify({ op: 'unsubscribe', channel: key }))
 *   }
 *
 *   protected startSubscribe(key: string) {
 *     this.ensureConnected()
 *     this.subscribedKeys.add(key)
 *     this.sendSubscribe(key)
 *   }
 *
 *   protected stopSubscribe(key: string) {
 *     this.subscribedKeys.delete(key)
 *     this.sendUnsubscribe(key)
 *     // Close connection when all keys are unsubscribed
 *     if (this.subscribedKeys.size === 0) {
 *       this.ws?.close()
 *       this.ws = undefined
 *     }
 *   }
 * }
 * ```
 *
 * Standalone mode example (WebSocket):
 * ```typescript
 * class OrderbookMonitor extends BaseMonitor<string, OrderbookData> {
 *   readonly mode = MonitorMode.Standalone
 *   get monitorName() { return 'orderbook' }
 *   private ws?: WebSocket
 *
 *   protected startStandalone() {
 *     this.ws = new WebSocket('wss://exchange/orderbook')
 *     this.ws.on('message', (raw) => {
 *       const { key, ...data } = JSON.parse(raw.toString())
 *       void this.push(key, data)
 *     })
 *   }
 *   protected stopStandalone() {
 *     this.ws?.close()
 *   }
 * }
 * ```
 */
export abstract class BaseMonitor<TKey extends string = string, TData = Record<string, unknown>> {
  private readonly refCounts = new Map<string, number>()
  private wildcardRefCount = 0
  private readonly emitHandlers: EmitHandler<TData>[] = []
  private readonly backfills = new Map<string, AbortController>()
  protected readonly dataDir: string
  private get log() { return createLogger(this.monitorName) }

  /**
   * Declares the run mode supported by this monitor. Override in subclass.
   */
  readonly mode: MonitorMode = MonitorMode.Any

  constructor(options?: MonitorOptions) {
    this.dataDir = getDataDir(options?.dataDir)
  }

  abstract get monitorName(): string

  /**
   * Machine-readable shape of the data this monitor emits — the monitor's
   * self-description. Consumers: the AI compiler's prompt (what getData()
   * returns), its dry-run mock-data synthesis, and dashboard display.
   * Metadata only; emit() does not validate against it.
   */
  get emitSchema(): ZodObject<ZodRawShape> | undefined {
    return undefined
  }

  /**
   * Machine-readable structure of this monitor's KEYS — what each ':'-joined
   * segment means. Drives the dashboard watch form, lets strategy triggers
   * pass structured keyParams instead of hand-formatted strings, and gives
   * the AI compiler a validated key contract.
   */
  get keySchema(): ZodObject<ZodRawShape> | undefined {
    return undefined
  }

  /**
   * Dashboard panels curating this monitor's data — the plotter convention.
   * Override to declare them; each definition's extract() runs server-side
   * over a window of persisted records and returns finished series for the
   * dashboard's generic chart. One definition = one panel = one unit/axis.
   */
  plots(): MonitorPlotDef<TData>[] {
    return []
  }

  /**
   * OPTIONAL historical backfill — override when this monitor's data can be
   * reconstructed from an archival source (klines, funding-rate history)
   * rather than only observed live.
   *
   * Called on the FIRST subscribe of a key, BEFORE live collection starts,
   * so consumers see a warm history instead of an empty file. `since` is the
   * ts of the newest already-persisted record for this key (undefined when
   * none) — the data file itself is the incremental watermark, so a restart
   * or re-subscribe fetches only the gap. Return records ASCENDING by ts
   * with each ts strictly greater than `since`; the base persists them
   * WITHOUT dispatching triggers (historical data must never fire a
   * strategy on stale signals). Throwing is non-fatal: the failure is
   * logged and live collection starts anyway.
   */
  protected backfill?(key: TKey, since: number | undefined, signal: AbortSignal): Promise<Array<{ ts: number; data: TData }>>

  /** True when this monitor (or class) implements the backfill hook. */
  get supportsBackfill(): boolean {
    return typeof this.backfill === 'function'
  }

  /**
   * Compose a key from structured params. Default: validate against
   * keySchema and join the field values with ':' in declaration order —
   * matching the 'venue:symbol[:timeframe]' convention. Override for
   * monitors with a different key format.
   */
  keyFor(params: Record<string, unknown>): TKey {
    const schema = this.keySchema
    if (!schema) throw new Error(`Monitor "${this.monitorName}" declares no keySchema — pass a raw key instead`)
    const parsed = schema.parse(params)
    return Object.keys(schema.shape).map(f => String(parsed[f])).join(':') as TKey
  }

  /**
   * Start in standalone mode. Override in subclass as needed.
   * Subclasses with mode=Subscribe do not need to implement this.
   */
  protected startStandalone(): void {
    throw new Error(`Monitor "${this.monitorName}" does not support standalone mode`)
  }

  /**
   * Stop standalone mode. Override in subclass as needed.
   * Subclasses with mode=Subscribe do not need to implement this.
   */
  protected stopStandalone(): void {
    throw new Error(`Monitor "${this.monitorName}" does not support standalone mode`)
  }

  /**
   * Start subscribe-driven mode for the given key. Override in subclass as needed.
   * Subclasses with mode=Standalone do not need to implement this.
   */
  protected startSubscribe(_key: TKey): void {
    throw new Error(`Monitor "${this.monitorName}" does not support subscribe mode`)
  }

  /**
   * Stop subscribe-driven mode for the given key. Override in subclass as needed.
   * Subclasses with mode=Standalone do not need to implement this.
   */
  protected stopSubscribe(_key: TKey): void {
    throw new Error(`Monitor "${this.monitorName}" does not support subscribe mode`)
  }

  /**
   * Start the monitor.
   * - No argument: standalone mode; throws if mode is Subscribe
   * - With argument: subscribe-driven mode; throws if mode is Standalone
   */
  start(key?: TKey): void {
    if (key === undefined) {
      if (this.mode === MonitorMode.Subscribe) {
        throw new Error(`Monitor "${this.monitorName}" only supports subscribe mode and cannot be started standalone`)
      }
      this.startStandalone()
    } else {
      if (this.mode === MonitorMode.Standalone) {
        throw new Error(`Monitor "${this.monitorName}" only supports standalone mode and cannot be started by subscribe`)
      }
      this.startSubscribe(key)
    }
  }

  /**
   * Stop the monitor.
   * - No argument: stop standalone mode
   * - With argument: stop collection for the given key
   */
  stop(key?: TKey): void {
    if (key === undefined) {
      if (this.mode === MonitorMode.Subscribe) {
        throw new Error(`Monitor "${this.monitorName}" only supports subscribe mode`)
      }
      this.stopStandalone()
    } else {
      if (this.mode === MonitorMode.Standalone) {
        throw new Error(`Monitor "${this.monitorName}" only supports standalone mode`)
      }
      this.stopSubscribe(key)
    }
  }

  subscribe(key: TKey): void {
    if (this.mode === MonitorMode.Standalone) {
      throw new Error(`Monitor "${this.monitorName}" only supports standalone mode and cannot be subscribed`)
    }
    const count = this.refCounts.get(key) ?? 0
    this.refCounts.set(key, count + 1)
    this.onSubscribe(key)
    if (count === 0) {
      this.onFirstSubscribe(key)
    }
  }

  unsubscribe(key: TKey): void {
    const count = this.refCounts.get(key) ?? 0
    if (count <= 1) {
      this.refCounts.delete(key)
      this.backfills.get(key)?.abort()
      this.onUnsubscribe(key)
      this.onLastUnsubscribe(key)
    } else {
      this.refCounts.set(key, count - 1)
      this.onUnsubscribe(key)
    }
  }

  hasSubscribers(key: string): boolean {
    return (this.refCounts.get(key) ?? 0) > 0
  }

  /** Read-only runtime status — which keys are live and how referenced (dashboard introspection). */
  status(): { mode: MonitorMode; activeKeys: Array<{ key: string; refCount: number }>; wildcardSubscribers: number; backfillingKeys?: string[] } {
    return {
      mode: this.mode,
      activeKeys: Array.from(this.refCounts, ([key, refCount]) => ({ key, refCount })),
      wildcardSubscribers: this.wildcardRefCount,
      ...(this.backfills.size > 0 ? { backfillingKeys: [...this.backfills.keys()] } : {}),
    }
  }

  /** Subscribe to all keys emitted by this monitor. Only valid for Standalone/Any mode monitors. */
  subscribeAll(): void {
    if (this.mode === MonitorMode.Subscribe) {
      throw new Error(`Monitor "${this.monitorName}" is Subscribe mode and does not support key: '*'`)
    }
    this.wildcardRefCount++
  }

  /** Unsubscribe from the wildcard subscription. */
  unsubscribeAll(): void {
    if (this.wildcardRefCount > 0) this.wildcardRefCount--
  }

  get hasWildcardSubscribers(): boolean {
    return this.wildcardRefCount > 0
  }

  protected onFirstSubscribe(key: TKey): void {
    if (this.backfill) void this.backfillThenStart(key)
    else this.start(key)
  }

  /**
   * Backfill orchestration: history lands before live collection starts, so
   * records stay time-ordered in the file and consumers never interleave a
   * fresh tick between two historical bars.
   */
  private async backfillThenStart(key: TKey): Promise<void> {
    if (this.backfills.has(key)) return
    const controller = new AbortController()
    this.backfills.set(key, controller)
    try {
      const since = (await this.getReader().readLatest(key))?.ts
      const records = await this.backfill!(key, since, controller.signal)
      const fresh = records
        .filter(r => since === undefined || r.ts > since)
        .sort((a, b) => a.ts - b.ts)
      if (fresh.length > 0 && !controller.signal.aborted) await this.appendHistorical(key, fresh)
      this.log.info({ key, since, appended: fresh.length }, 'Backfill complete')
    } catch (err) {
      this.log.warn({ key, err }, 'Backfill failed — starting live collection without history')
    } finally {
      this.backfills.delete(key)
    }
    if (this.hasSubscribers(key) && !controller.signal.aborted) this.start(key)
  }

  /** Persist records with THEIR OWN timestamps and no trigger dispatch — the backfill write path. */
  protected async appendHistorical(key: TKey, records: Array<{ ts: number; data: TData }>): Promise<void> {
    const filePath = getMonitorPath(this.dataDir, this.monitorName, key)
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    const lines = records.map(r => JSON.stringify({ ts: r.ts, data: r.data })).join('\n') + '\n'
    await fs.promises.appendFile(filePath, lines, 'utf8')
  }

  protected onLastUnsubscribe(key: TKey): void {
    this.stop(key)
  }

  protected onSubscribe(_key: TKey): void {}
  protected onUnsubscribe(_key: TKey): void {}

  protected onBeforeEmit(_key: TKey, _data: TData): void {}
  protected onAfterEmit(_key: TKey, _data: TData): void {}

  /**
   * Called by subclasses when new data is collected. Base class handles persistence and event dispatch.
   * Errors in append or emit are logged but do not interrupt the collection loop.
   */
  protected async push(key: TKey, data: TData): Promise<void> {
    try {
      await this.append(key, data)
    } catch (err) {
      this.log.error({ key, err }, 'Failed to append monitor data')
    }
    try {
      await this.emit(key, data)
    } catch (err) {
      this.log.error({ key, err }, 'Failed to emit monitor data')
    }
  }

  protected async append(key: TKey, data: TData): Promise<void> {
    const filePath = getMonitorPath(this.dataDir, this.monitorName, key)
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    const record = { ts: Date.now(), data }
    await fs.promises.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8')
  }

  getReader(): MonitorDataReader<TData> {
    const monitorDir = path.join(this.dataDir, 'monitors', this.monitorName)
    return new MonitorDataReaderImpl<TData>(monitorDir)
  }

  addEmitHandler(handler: EmitHandler<TData>): void {
    this.emitHandlers.push(handler)
  }

  removeEmitHandler(handler: EmitHandler<TData>): void {
    const idx = this.emitHandlers.indexOf(handler)
    if (idx !== -1) this.emitHandlers.splice(idx, 1)
  }

  /** @deprecated Use addEmitHandler instead */
  setEmitHandler(handler: EmitHandler<TData>): void {
    this.emitHandlers.push(handler)
  }

  protected async emit(key: TKey, data: TData): Promise<void> {
    if (!this.hasSubscribers(key) && !this.hasWildcardSubscribers && this.emitHandlers.length === 0) return
    this.onBeforeEmit(key, data)
    for (const handler of this.emitHandlers) {
      await handler(key, data)
    }
    this.onAfterEmit(key, data)
  }
}
