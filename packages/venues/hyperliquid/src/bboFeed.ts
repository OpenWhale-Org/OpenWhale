import { createLogger } from '@openwhaleorg/core'

/**
 * Hyperliquid's best bid/offer stream.
 *
 * ccxt has no `watchBidsAsks` for this venue, so its `watchTicker` falls to
 * `allMids` — a five-second broadcast of every mid on the dex. Measured
 * 2026-09-09 over 30s on `xyz:KORU`: allMids 6 frames (5072ms apart), l2Book 7
 * (5428ms), `bbo` 61 (174ms). For a strategy whose edge is a deviation between
 * two prices, a five-second price is not a price.
 *
 * So the venue's own `bbo` channel, spoken directly. One socket per adapter,
 * multiplexed across every coin the adapter watches — Hyperliquid accepts many
 * subscriptions per connection, and a socket per symbol would multiply
 * handshakes for nothing.
 *
 * Node's global WebSocket (22+) rather than a dependency: this file is the only
 * place in the repo that speaks a venue's websocket protocol directly, and a
 * package added for one file is a package to keep patched for ever.
 */

const WS_URL = 'wss://api.hyperliquid.xyz/ws'
/** Hyperliquid closes an idle socket; its own docs use a 60s budget. */
const PING_MS = 30_000
const RECONNECT_MS = [500, 1_000, 2_000, 5_000, 10_000] as const

export interface Bbo { bid?: number; ask?: number; timestamp?: number }

type Listener = (q: Bbo) => void

/**
 * One connection, many coins.
 *
 * Subscriptions are reference-counted per coin: several monitors watching the
 * same market share one subscription, and the venue is only told to stop when
 * the last of them goes. On reconnect every live coin is re-subscribed, since
 * the venue keeps no memory of a closed socket.
 */
export class HyperliquidBboFeed {
  private ws: WebSocket | undefined
  private readonly listeners = new Map<string, Set<Listener>>()
  private ping: ReturnType<typeof setInterval> | undefined
  private attempt = 0
  private closed = false
  private get log() { return createLogger('HyperliquidBboFeed') }

  /** Listen to one coin. The returned function detaches it. */
  subscribe(coin: string, onQuote: Listener): () => void {
    let set = this.listeners.get(coin)
    if (!set) {
      set = new Set()
      this.listeners.set(coin, set)
      this.send({ method: 'subscribe', subscription: { type: 'bbo', coin } })
    }
    set.add(onQuote)
    this.connect()
    return () => {
      const live = this.listeners.get(coin)
      if (!live) return
      live.delete(onQuote)
      if (live.size > 0) return
      this.listeners.delete(coin)
      this.send({ method: 'unsubscribe', subscription: { type: 'bbo', coin } })
    }
  }

  /** Drop the socket and every subscription — the adapter is going away. */
  close(): void {
    this.closed = true
    this.listeners.clear()
    if (this.ping) { clearInterval(this.ping); this.ping = undefined }
    try { this.ws?.close() } catch { /* already gone */ }
    this.ws = undefined
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg))
    // Not connected yet: `connect` replays every live subscription on open,
    // so a message dropped here is re-sent rather than lost.
  }

  private connect(): void {
    if (this.closed || this.ws) return
    const ws = new WebSocket(WS_URL)
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      for (const coin of this.listeners.keys()) {
        ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'bbo', coin } }))
      }
      this.ping = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ method: 'ping' }))
      }, PING_MS)
    }

    ws.onmessage = (ev: MessageEvent) => {
      let m: unknown
      try { m = JSON.parse(String(ev.data)) } catch { return }
      const frame = m as { channel?: string; data?: { coin?: string; time?: number; bbo?: Array<{ px?: string } | null> } }
      if (frame.channel !== 'bbo' || !frame.data?.coin) return
      const set = this.listeners.get(frame.data.coin)
      if (!set?.size) return
      // bbo is [bid, ask]; either side can be null on an empty book, and a
      // half-quote is still worth forwarding — the consumer decides.
      const bid = Number(frame.data.bbo?.[0]?.px)
      const ask = Number(frame.data.bbo?.[1]?.px)
      const q: Bbo = {
        ...(Number.isFinite(bid) && bid > 0 ? { bid } : {}),
        ...(Number.isFinite(ask) && ask > 0 ? { ask } : {}),
        timestamp: frame.data.time ?? Date.now(),
      }
      if (q.bid === undefined && q.ask === undefined) return
      for (const fn of set) fn(q)
    }

    const drop = (why: string) => {
      if (this.ws !== ws) return
      if (this.ping) { clearInterval(this.ping); this.ping = undefined }
      this.ws = undefined
      if (this.closed || this.listeners.size === 0) return
      const wait = RECONNECT_MS[Math.min(this.attempt++, RECONNECT_MS.length - 1)]!
      this.log.warn({ why, wait, coins: this.listeners.size }, 'bbo socket dropped — reconnecting')
      setTimeout(() => this.connect(), wait)
    }
    ws.onclose = () => drop('close')
    ws.onerror = () => drop('error')
  }
}
