import { OwAccount } from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { BinanceAdapter } from './adapter.js'

/**
 * Binance specialization of the perp account — the (exchange/perp, 'binance')
 * cell of the account matrix. Exists for one reason: Portfolio Margin equity.
 *
 * Under Portfolio Margin, the generic recipe (stable collateral + Σ position PnL)
 * undercounts collateral to ~0 and reports negative equity; Binance publishes
 * the real account value itself, so we use it. Classic (non-PM) credentials
 * fall through to the generic recipe unchanged.
 *
 * Duck-typed (never instanceof): the session is only a BinanceAdapter when
 * the binance adapter cell built it, which is exactly when these members exist.
 */
@OwAccount({ id: 'perp-account', kind: 'exchange/perp', type: 'binance', displayName: 'Binance Perp Account' })
export class BinancePerpAccount extends PerpAccount {
  override async snapshot(): Promise<{ equity: number; available?: number; unrealizedPnl?: number }> {
    const s = this.session as Partial<BinanceAdapter>
    if (s.isUnifiedAccount && typeof s.fetchUnifiedEquity === 'function') {
      return s.fetchUnifiedEquity()
    }
    return super.snapshot()
  }
}
