import { OwAccount } from '@openwhaleorg/core'
import type { WalletBalance, WhaleDanceWalletSession } from './types.js'

function walletTotals(balance: WalletBalance): { totalUsd: number; availableUsd: number } {
  const perpEquity = Number(balance.accountValue)
  const perpWithdrawable = Number(balance.withdrawable)
  const spotUsdc = Number(balance.spotUsdc)

  // In a unified account, spot USDC already includes the collateral backing
  // perp positions. Perp equity alone omits idle funds; summing both counts
  // the position collateral twice. Older accounts without spot USDC use perp.
  if (spotUsdc > 0) {
    return {
      totalUsd: spotUsdc,
      availableUsd: Math.max(0, spotUsdc - perpEquity + perpWithdrawable),
    }
  }

  return { totalUsd: perpEquity, availableUsd: perpWithdrawable }
}

const sections = [
  { method: 'identity', title: 'Identity', kind: 'keyvalue' as const, default: true },
  { method: 'policy', title: 'Policy', kind: 'keyvalue' as const },
  {
    method: 'balance', title: 'Balance', kind: 'keyvalue' as const,
    columns: [
      { key: 'totalUsd', label: 'Total', format: 'usd' as const },
      { key: 'availableUsd', label: 'Available', format: 'usd' as const },
      { key: 'spotUsdc', label: 'Spot USDC', format: 'mono' as const },
      { key: 'accountValue', label: 'Perp Equity', format: 'mono' as const },
      { key: 'withdrawable', label: 'Perp Withdrawable', format: 'mono' as const },
      { key: 'totalMarginUsed', label: 'Margin Used', format: 'mono' as const },
      { key: 'loading', label: 'Loading' },
    ],
  },
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

  async balance() {
    const balance = await this.session.getBalance()
    return { ...balance, ...walletTotals(balance) }
  }
  positions() { return this.session.getPositions() }
  orders() { return this.session.getOrders() }

  async snapshot(): Promise<{ equity: number; available?: number }> {
    const { totalUsd, availableUsd } = walletTotals(await this.session.getBalance())
    return { equity: totalUsd, available: availableUsd }
  }
}
