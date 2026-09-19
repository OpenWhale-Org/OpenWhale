export type WalletScope =
  | 'wallet:read'
  | 'orders:write'
  | 'orders:cancel'
  | 'positions:close'
  | 'positions:manage'

export interface WalletPolicy {
  allowedAssets: string[]
  maxLeverage: number
  maxOrderNotionalUsd: number
  maxDailyNotionalUsd: number
  maxSlippageBps: number
}

export interface WalletIdentity {
  id: string
  venue: string
  address: string
  scopes: WalletScope[]
  policy: WalletPolicy
}

export interface WalletBalance {
  accountValue: string
  withdrawable: string
  totalMarginUsed: string
  spotUsdc: string
  loading: boolean
}

export interface WalletPosition {
  coin: string
  size: string
  entryPrice: string
  positionValue: string
  side: 'long' | 'short' | 'flat'
  leverage: number
  marginMode: 'cross' | 'isolated'
  unrealizedPnl: string
  liquidationPrice?: string
  raw: unknown
}

export interface WalletOrder {
  coin: string
  side: 'buy' | 'sell'
  price: string
  size: string
  originalSize: string
  orderId: string
  timestamp: number
  reduceOnly: boolean
  orderType: string
  raw: unknown
}

export type WalletCommand =
  | { action: 'openMarket'; coin: string; isBuy: boolean; marginUsd: number; leverage: number; slippageBps?: number }
  | { action: 'openLimit'; coin: string; isBuy: boolean; marginUsd: number; price: number; leverage: number }
  | { action: 'closePosition'; coin: string; size: number; slippageBps?: number }
  | { action: 'setLeverage'; coin: string; leverage: number; isCross?: boolean }
  | { action: 'adjustIsolatedMargin'; coin: string; deltaUsd: number }
  | { action: 'setTpSl'; coin: string; size: number; tpPrice?: number; slPrice?: number }
  | { action: 'cancelOrders'; cancels: Array<{ coin: string; orderId: number }> }

export type WalletExecutionStatus = 'succeeded' | 'failed' | 'pending' | 'unknown'

export interface WalletExecutionOutcome {
  executionId?: string
  status: WalletExecutionStatus
  idempotencyKey: string
  replayed?: boolean
  result?: unknown
  error?: string
}

export interface WalletExecution {
  id: string
  action: string
  asset?: string
  status: WalletExecutionStatus
  result?: unknown
  error?: unknown
  createdAt?: string
  completedAt?: string
}

export interface WhaleDanceWalletSession {
  getIdentity(): Promise<WalletIdentity>
  getBalance(): Promise<WalletBalance>
  getPositions(): Promise<WalletPosition[]>
  getOrders(): Promise<WalletOrder[]>
  execute(command: WalletCommand, commandId: string): Promise<WalletExecutionOutcome>
  getExecution(executionId: string): Promise<WalletExecution>
  close(): Promise<void>
}

declare module '@openwhaleorg/core' {
  interface AdapterKindMap {
    'whaledance/wallet': { session: WhaleDanceWalletSession; reader: unknown }
  }
}
