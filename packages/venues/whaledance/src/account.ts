import { OwAccount } from '@openwhaleorg/core'
import type { WhaleDanceWalletSession } from './types.js'

const sections = [
  { method: 'identity', title: 'Identity', kind: 'keyvalue' as const, default: true },
  { method: 'policy', title: 'Policy', kind: 'keyvalue' as const },
  { method: 'balance', title: 'Balance', kind: 'keyvalue' as const },
  {
    method: 'positions', title: 'Positions', kind: 'table' as const, count: true, empty: 'No open positions',
    columns: [
      { key: 'coin', label: 'Asset', grow: true },
      { key: 'side', label: 'Side', format: 'side' as const },
      { key: 'size', label: 'Size', format: 'mono' as const },
      { key: 'entryPrice', label: 'Entry', format: 'mono' as const },
      { key: 'positionValue', label: 'Value', format: 'mono' as const },
      { key: 'unrealizedPnl', label: 'PnL', format: 'mono' as const },
      { key: 'leverage', label: 'Leverage', format: 'number' as const },
      { key: 'marginMode', label: 'Margin', format: 'badge' as const },
    ],
  },
  {
    method: 'orders', title: 'Orders', kind: 'table' as const, count: true, empty: 'No open orders',
    columns: [
      { key: 'coin', label: 'Asset', grow: true },
      { key: 'side', label: 'Side', format: 'side' as const },
      { key: 'price', label: 'Price', format: 'mono' as const },
      { key: 'size', label: 'Size', format: 'mono' as const },
      { key: 'orderId', label: 'Order ID', format: 'mono' as const },
      { key: 'orderType', label: 'Type', format: 'badge' as const },
      { key: 'timestamp', label: 'Time', format: 'time' as const },
    ],
  },
]

@OwAccount({
  id: 'wallet-account',
  kind: 'whaledance/wallet',
  venue: 'whaledance/wallet',
  displayName: 'WhaleDance Wallet',
  icon: '🐋',
  sections,
})
export class WhaleDanceWalletAccount {
  static readonly kind = 'whaledance/wallet' as const
  static readonly venueType = 'whaledance/wallet'

  constructor(
    readonly name: string,
    protected readonly session: WhaleDanceWalletSession,
  ) {}

  async identity(): Promise<Record<string, unknown>> {
    const identity = await this.session.getIdentity()
    return {
      accountId: identity.id,
      executionProvider: 'WhaleDance',
      marketVenue: identity.venue,
      address: identity.address,
      scopes: identity.scopes.join(', '),
    }
  }

  async policy(): Promise<Record<string, unknown>> {
    const { policy } = await this.session.getIdentity()
    return {
      allowedAssets: policy.allowedAssets.length === 0 ? 'All registered assets' : policy.allowedAssets.join(', '),
      maxLeverage: policy.maxLeverage,
      maxOrderNotionalUsd: policy.maxOrderNotionalUsd,
      maxDailyNotionalUsd: policy.maxDailyNotionalUsd,
      maxSlippageBps: policy.maxSlippageBps,
    }
  }

  balance() { return this.session.getBalance() }
  positions() { return this.session.getPositions() }
  orders() { return this.session.getOrders() }

  async snapshot(): Promise<{ equity: number; available?: number }> {
    const balance = await this.session.getBalance()
    return { equity: Number(balance.accountValue), available: Number(balance.withdrawable) }
  }
}
