import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import { TerminalAdapterError } from '@openwhaleorg/core'

export interface BinanceCredentials {
  apiKey: string
  secret: string
  /** Use the Binance Futures testnet (testnet.binancefuture.com). Default: false. */
  testnet?: boolean
  /**
   * Portfolio Margin (unified account): route every private call through the papi
   * endpoints, so margin is shared across UM futures / CM futures / margin
   * positions instead of siloed per product. Requires the account to have
   * Portfolio Margin enabled AND an API key created for it. Default: false.
   */
  unifiedAccount?: boolean
}

/**
 * Binance USDⓈ-M perpetual futures adapter.
 *
 * Pure CcxtAdapter configuration — ccxt's 'binanceusdm' needs no venue quirk
 * overrides for the PerpExchangeAdapter surface.
 *
 * With `unifiedAccount`, ccxt's portfolioMargin option flips every private
 * endpoint (balance, orders, positions, leverage) to the papi variants while
 * the public market-data surface stays identical — strategy and executor code
 * never notices which account structure it is trading against.
 */
export class BinanceAdapter extends CcxtAdapter {
  constructor(credentials: BinanceCredentials) {
    if (credentials.unifiedAccount && credentials.testnet) {
      // Binance has no Portfolio Margin testnet — silently falling back to
      // the classic testnet would validate the wrong account structure.
      throw new TerminalAdapterError(
        'Binance Portfolio Margin has no testnet — disable one of unifiedAccount/testnet on this credential.'
      )
    }
    super({
      exchangeId: 'binanceusdm',
      apiKey: credentials.apiKey,
      secret: credentials.secret,
      ...(credentials.testnet !== undefined ? { testnet: credentials.testnet } : {}),
      ...(credentials.unifiedAccount ? { ccxtOptions: { options: { portfolioMargin: true } } } : {}),
    })
  }

  /** True when this session trades through the Portfolio Margin (papi) endpoints. */
  get isUnifiedAccount(): boolean {
    return (this.exchange.options as Record<string, unknown>)['portfolioMargin'] === true
  }

  /**
   * Position mode (one-way vs hedge) — read from the endpoint this ACCOUNT
   * actually owns.
   *
   * ccxt's fetchPositionMode always calls GET /fapi/v1/positionSide/dual with
   * no portfolio-margin branch, and a PM-enabled key is not permitted there:
   * it answers -2015, callers fall back to "one-way", and every order then
   * goes out without positionSide — which a hedge-mode account rejects with
   * -4061. The PM answer lives at GET /papi/v1/um/positionSide/dual.
   */
  override async fetchPositionMode(symbol?: string): Promise<{ hedged: boolean }> {
    if (!this.isUnifiedAccount) return super.fetchPositionMode(symbol)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await this.guard(() => (this.exchange as any).papiGetUmPositionSideDual({})) as { dualSidePosition?: boolean | string }
    // Binance answers with a real boolean here, but the REST layer has been
    // known to stringify it — treat both spellings as the same truth.
    return { hedged: response.dualSidePosition === true || response.dualSidePosition === 'true' }
  }

  /**
   * Portfolio Margin equity via the OFFICIAL account-level figures:
   * GET /papi/v1/account → actualEquity (account value in USD, collateral
   * haircuts NOT applied — the honest net-worth number) and
   * totalAvailableBalance. Unrealized PnL comes from /papi/v1/balance's
   * per-asset umUnrealizedPNL/cmUnrealizedPNL (garnish — a failure there
   * never fails the sample).
   *
   * This replaces the generic "stable collateral + Σ position PnL" recipe,
   * which under PM undercounts collateral (ccxt's papi balance rows don't
   * land in the stable-token aggregate) and produced negative equity.
   */
  async fetchUnifiedEquity(): Promise<{ equity: number; available?: number; unrealizedPnl?: number }> {
    const ex = this.exchange as unknown as {
      papiGetAccount(params?: Record<string, unknown>): Promise<Record<string, unknown>>
      papiGetBalance(params?: Record<string, unknown>): Promise<Array<Record<string, unknown>>>
    }
    const account = await ex.papiGetAccount()
    const equity = Number(account['actualEquity'])
    if (!Number.isFinite(equity)) {
      throw new Error(`papi/v1/account returned no actualEquity (got: ${JSON.stringify(account).slice(0, 200)})`)
    }
    const available = Number(account['totalAvailableBalance'])

    let unrealizedPnl: number | undefined
    try {
      const rows = await ex.papiGetBalance()
      unrealizedPnl = rows.reduce(
        (sum, r) => sum + (Number(r['umUnrealizedPNL']) || 0) + (Number(r['cmUnrealizedPNL']) || 0),
        0,
      )
    } catch {
      // uPnL is supplementary — equity stands on its own
    }

    return {
      equity,
      ...(Number.isFinite(available) ? { available } : {}),
      ...(unrealizedPnl !== undefined ? { unrealizedPnl } : {}),
    }
  }
}
