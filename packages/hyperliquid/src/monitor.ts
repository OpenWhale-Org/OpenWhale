import { BaseMonitor, MonitorMode } from '@openwhale/core'
import type { ExchangeTrade } from '@openwhale/core'
import type { HyperliquidAdapter } from './adapter.js'

/**
 * Monitors real-time trades for a specific wallet address on Hyperliquid.
 *
 * key: target wallet address (e.g. "0xABC...")
 * data: ExchangeTrade — one trade per emit
 *
 * Uses ccxt.pro watchMyTrades with params.user to subscribe to any address's
 * userFills WebSocket stream.
 */
export class UserTradesMonitor extends BaseMonitor<string, ExchangeTrade> {
  readonly mode = MonitorMode.Subscribe

  private readonly loops = new Map<string, AbortController>()

  constructor(private readonly adapter: HyperliquidAdapter) {
    super()
  }

  get monitorName(): string {
    return 'user-trades'
  }

  protected startSubscribe(key: string): void {
    const controller = new AbortController()
    this.loops.set(key, controller)
    void this.watchLoop(key, controller.signal)
  }

  protected stopSubscribe(key: string): void {
    this.loops.get(key)?.abort()
    this.loops.delete(key)
  }

  private async watchLoop(address: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.adapter.watchMyTrades(
          async (trades) => {
            for (const trade of trades) {
              if (!signal.aborted) await this.push(address, trade)
            }
          },
          { user: address },
        )
      } catch (err: any) {
        if (signal.aborted) return
        // Reconnect after brief delay on unexpected errors
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
  }
}
