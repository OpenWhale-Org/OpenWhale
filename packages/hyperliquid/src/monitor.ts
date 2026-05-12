import { BaseMonitor, MonitorMode, createLogger } from '@openwhale/core'
import type { ExchangeTrade } from '@openwhale/core'
import type { HyperliquidAdapter } from './adapter.js'

const log = createLogger('UserTradesMonitor')

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
    log.info({ address: key }, 'Starting subscription')
    const controller = new AbortController()
    this.loops.set(key, controller)
    // Record the subscription start time — trades with earlier timestamps are
    // historical backfill from ccxt and must be ignored.
    const subscribedAt = Date.now()
    void this.watchLoop(key, controller.signal, subscribedAt)
  }

  protected stopSubscribe(key: string): void {
    log.info({ address: key }, 'Stopping subscription')
    this.loops.get(key)?.abort()
    this.loops.delete(key)
  }

  private async watchLoop(address: string, signal: AbortSignal, subscribedAt: number): Promise<void> {
    log.debug({ address }, 'Watch loop started')
    let reconnects = 0

    while (!signal.aborted) {
      try {
        log.debug({ address, reconnects }, 'Connecting to userFills stream')
        await this.adapter.watchMyTrades(
          async (trades) => {
            const newTrades = trades.filter(t => t.timestamp >= subscribedAt)
            if (trades.length !== newTrades.length)
              log.debug({ address, total: trades.length, filtered: trades.length - newTrades.length }, 'Filtered historical trades')
            log.debug({ address, count: newTrades.length }, 'Received trades batch')
            for (const trade of newTrades) {
              if (signal.aborted) return
              log.info(
                {
                  address,
                  symbol: trade.symbol,
                  side: trade.side,
                  price: trade.price,
                  amount: trade.amount,
                  cost: trade.cost,
                  takerOrMaker: trade.takerOrMaker,
                  tradeId: trade.id,
                  timestamp: trade.timestamp,
                },
                'Trade received',
              )
              await this.push(address, trade)
            }
          },
          { user: address },
        )
        reconnects = 0
      } catch (err: any) {
        if (signal.aborted) return
        reconnects++
        log.warn({ address, reconnects, err: err?.message }, 'Stream error — reconnecting in 2s')
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }

    log.debug({ address }, 'Watch loop exited')
  }
}
