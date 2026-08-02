import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import type { ExchangeOrder, FundingRateData, PerpOrderParams } from '@openwhaleorg/exchange'

export interface HyperliquidCredentials {
  walletAddress: string
  privateKey?: string
  /** Use the Hyperliquid testnet instead of mainnet. Default: false. */
  testnet?: boolean
}

/**
 * Hyperliquid adapter: the generic CcxtAdapter plus venue quirks.
 * Everything else (mapping, watch loops, error translation, precision)
 * is inherited.
 */
export class HyperliquidAdapter extends CcxtAdapter {
  /** Keyless form (no credentials) = public data only — used by the market monitors. */
  constructor(credentials?: Partial<HyperliquidCredentials>) {
    super({
      exchangeId: 'hyperliquid',
      ...(credentials?.walletAddress ? { walletAddress: credentials.walletAddress } : {}),
      ...(credentials?.privateKey ? { privateKey: credentials.privateKey } : {}),
      ...(credentials?.testnet !== undefined ? { testnet: credentials.testnet } : {}),
    })
  }

  /** perpDexs list cache — the builder-dex roster changes rarely. */
  private hip3Dexes: string[] | undefined
  private hip3DexesFetchedAt = 0

  /**
   * Quirk: ccxt's fetchFundingRates hits metaAndAssetCtxs WITHOUT a dex
   * param, so it only covers the main universe. HIP-3 (builder-deployed)
   * markets settle hourly too — aggregate every dex so funding-driven
   * consumers see them. ccxt already loads HIP-3 markets by default and
   * accepts `{ dex }` on the same call; each per-dex failure is non-fatal
   * (a broken builder dex must not blind the main universe).
   */
  override async fetchFundingRates(): Promise<FundingRateData[]> {
    // HIP-3 symbol mapping (hip3TokensByName) is built during loadMarkets —
    // without it parseFundingRates would emit raw ids for builder-dex coins.
    // ccxt caches the result, so this is a no-op after the first call.
    await this.guard(() => this.exchange.loadMarkets())
    const main = await super.fetchFundingRates()
    const dexes = await this.listHip3Dexes()
    const perDex = await Promise.all(dexes.map(async (dex) => {
      try {
        const rates = await this.guard(() => this.exchange.fetchFundingRates(undefined, { dex }))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Object.values(rates).map((r: any) => this.mapFundingRate(r))
      } catch {
        return [] as FundingRateData[]
      }
    }))
    return [...main, ...perDex.flat()]
  }

  private async listHip3Dexes(): Promise<string[]> {
    if (this.hip3Dexes && Date.now() - this.hip3DexesFetchedAt < 6 * 3_600_000) return this.hip3Dexes
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = await this.guard(() => (this.exchange as any).publicPostInfo({ type: 'perpDexs' })) as Array<{ name?: string } | null>
      this.hip3Dexes = raw
        .map(d => d?.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
      this.hip3DexesFetchedAt = Date.now()
    } catch {
      this.hip3Dexes = this.hip3Dexes ?? []
    }
    return this.hip3Dexes
  }

  /**
   * Quirk: Hyperliquid requires a price for market orders to compute the max
   * slippage bound. When absent, use the current last price and let ccxt apply
   * its default slippage tolerance.
   */
  override async createOrder(params: PerpOrderParams): Promise<ExchangeOrder> {
    if (params.type === 'market' && params.price === undefined) {
      const ticker = await this.fetchTicker(params.symbol)
      if (ticker.last > 0) return super.createOrder({ ...params, price: ticker.last })
    }
    return super.createOrder(params)
  }

  /**
   * Quirk: Hyperliquid's setMarginMode requires a leverage param (ccxt throws
   * ArgumentsRequired without it) — default to the position's current leverage.
   */
  override async setMarginMode(symbol: string, marginMode: 'cross' | 'isolated', params?: Record<string, unknown>): Promise<void> {
    let leverage = params?.leverage as number | undefined
    if (leverage === undefined) {
      const pos = await this.fetchPosition(symbol)
      leverage = pos.leverage || 1
    }
    return super.setMarginMode(symbol, marginMode, { ...params, leverage })
  }
}
