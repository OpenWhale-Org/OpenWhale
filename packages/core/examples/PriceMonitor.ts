/**
 * Example: PriceMonitor
 *
 * Subscribe-mode monitor — polls a price endpoint every N seconds,
 * with each trading pair (key) maintaining its own setInterval.
 *
 * Key points:
 * - mode = MonitorMode.Subscribe: driven by TriggerManager via subscribe(key)
 * - startSubscribe(key) starts polling; stopSubscribe(key) clears the timer
 * - Call this.push(key, data) to submit data; base class handles JSONL writes and emit
 * - Storage format: { ts: number, data: { price, volume24h, change24h } } (MonitorRecord structure)
 * - No manual ref-count management needed; the base class handles it
 */

import { BaseMonitor, MonitorMode } from '../src/monitor/BaseMonitor.js'

export class PriceMonitor extends BaseMonitor {
  readonly mode = MonitorMode.Subscribe

  get monitorName() {
    return 'price'
  }

  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly intervalMs: number

  constructor(intervalMs = 5000) {
    super()
    this.intervalMs = intervalMs
  }

  protected startSubscribe(key: string): void {
    // run immediately once, then repeat on interval
    void this.fetchAndPush(key)
    const timer = setInterval(() => void this.fetchAndPush(key), this.intervalMs)
    this.timers.set(key, timer)
  }

  protected stopSubscribe(key: string): void {
    const timer = this.timers.get(key)
    if (timer !== undefined) {
      clearInterval(timer)
      this.timers.delete(key)
    }
  }

  private async fetchAndPush(key: string): Promise<void> {
    const data = await this.fetchPrice(key)
    await this.push(key, data)
  }

  /**
   * In a real project, replace with an actual API call, e.g.:
   *   const res = await fetch(`https://api.exchange.com/ticker/${key}`)
   *   return res.json()
   */
  private async fetchPrice(symbol: string): Promise<Record<string, unknown>> {
    // simulated price data
    const base = symbol === 'BTC' ? 65000 : symbol === 'ETH' ? 3500 : 100
    return {
      price:     base * (1 + (Math.random() - 0.5) * 0.02),
      volume24h: Math.random() * 1e9,
      change24h: (Math.random() - 0.5) * 10,
    }
  }
}
