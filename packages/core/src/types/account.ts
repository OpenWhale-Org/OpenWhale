import type { RawCredentialData } from './credential.js'

export interface IBalance {
  available: number   // Available funds (USD-denominated)
  total: number       // Total assets (USD-denominated)
  currency: string    // Quote currency, e.g. 'USDT', 'USD'
}

export interface IPosition {
  id: string
  value: number       // Current market value (USD-denominated)
  pnl: number         // Unrealized PnL (USD-denominated)
}

export interface IOrder {
  id: string
  side: 'buy' | 'sell'
  value: number       // Order value (USD-denominated)
  status: 'open' | 'partial'
}

export interface IPnL {
  realized: number
  unrealized: number
  currency: string
}

export interface IHistoryRecord {
  id: string
  timestamp: number
  type: string        // 'trade' | 'transfer' | 'funding' | ...
  value: number       // USD-denominated
}

export interface IAccount {
  readonly name: string         // Credential name, e.g. "HL Main"
  readonly accountType: string  // e.g. "hyperliquid"

  balance(): Promise<IBalance>
  positions(): Promise<IPosition[]>
  orders(): Promise<IOrder[]>
  pnl(since?: Date): Promise<IPnL>
  history(limit?: number): Promise<IHistoryRecord[]>
}

/** Factory function that creates an IAccount from decrypted credential data. */
export type AccountFactory = (data: RawCredentialData) => IAccount
