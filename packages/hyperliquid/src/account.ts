import type { IAccount, IBalance, IPosition, IOrder, IPnL, IHistoryRecord } from '@openwhale/core'
import type { HyperliquidAdapter } from './adapter.js'

export class HyperliquidAccount implements IAccount {
  readonly name: string
  readonly accountType = 'hyperliquid'

  constructor(
    name: string,
    private readonly adapter: HyperliquidAdapter,
  ) {
    this.name = name
  }

  /** Returns the underlying adapter for use by executors that need direct exchange access. */
  getAdapter(): HyperliquidAdapter {
    return this.adapter
  }

  async balance(): Promise<IBalance> {
    const balances = await this.adapter.fetchBalance()
    const usd = balances.find(b => b.currency === 'USDC' || b.currency === 'USD') ?? balances[0]
    return {
      available: usd?.free ?? 0,
      total: usd?.total ?? 0,
      currency: usd?.currency ?? 'USDC',
    }
  }

  async positions(): Promise<IPosition[]> {
    const positions = await this.adapter.fetchPositions()
    return positions
      .filter(p => p.contracts !== 0)
      .map(p => ({
        id: p.symbol,
        value: p.notional,
        pnl: p.unrealizedPnl,
      }))
  }

  async orders(): Promise<IOrder[]> {
    const orders = await this.adapter.fetchOpenOrders()
    return orders.map(o => ({
      id: o.id,
      side: o.side,
      value: o.amount * o.price,
      status: o.filled > 0 ? 'partial' as const : 'open' as const,
    }))
  }

  async pnl(since?: Date): Promise<IPnL> {
    const positions = await this.adapter.fetchPositions()
    const unrealized = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0)

    // Realized PnL from trade history
    const trades = await this.adapter.fetchOrders(undefined, 200)
    const sinceTs = since?.getTime() ?? 0
    const realized = trades
      .filter(o => o.status === 'closed' && o.timestamp >= sinceTs)
      .reduce((sum, o) => {
        // Approximate realized PnL from fee cost (HL doesn't expose realized PnL per order via ccxt)
        return sum - (o.fee?.cost ?? 0)
      }, 0)

    return { realized, unrealized, currency: 'USDC' }
  }

  async history(limit = 50): Promise<IHistoryRecord[]> {
    const trades = await this.adapter.fetchOrders(undefined, limit)
    return trades
      .filter(o => o.status === 'closed')
      .map(o => ({
        id: o.id,
        timestamp: o.timestamp,
        type: 'trade',
        value: o.amount * o.price,
      }))
  }
}
