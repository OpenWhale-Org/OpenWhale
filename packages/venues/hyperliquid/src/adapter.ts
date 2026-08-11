import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import { createLogger, TerminalAdapterError } from '@openwhaleorg/core'
import type { ExchangeFill, ExchangeOrder, ExchangePosition, FundingRateData, PerpOrderParams } from '@openwhaleorg/exchange'
import { decidePriority, isPriorityBalanceRejection, priorityP } from './priority.js'

/**
 * ccxt internals the priority path borrows. None of these are ccxt's public
 * API, so their presence is checked at run time and the feature turns itself
 * off rather than taking order placement down with it.
 */
const CCXT_INTERNALS = ['createOrderRequest', 'signL1Action', 'privatePostExchange', 'milliseconds'] as const

interface CcxtInternals {
  createOrderRequest(symbol: string, type: string, side: string, amount: number, price: number | undefined, params: Record<string, unknown>): Record<string, unknown>
  signL1Action(action: unknown, nonce: number, vaultAddress?: string): unknown
  privatePostExchange(request: unknown): Promise<Record<string, unknown>>
  milliseconds(): number
  numberToString(n: number): string
  initializeClient(): Promise<boolean>
  safeStringLower(o: unknown, k: string, d?: unknown): string
  safeDict(o: unknown, k: string, d?: unknown): Record<string, unknown>
  safeList(o: unknown, k: string, d?: unknown): unknown[]
  parseOrders(orders: unknown[], market?: unknown): unknown[]
}

/**
 * OpenWhale's builder code.
 *
 * Hyperliquid lets whoever routes an order charge a fee on top of the venue's,
 * declared per order as `builder: { b: <address>, f: <TENTHS of a basis point> }`.
 * It is the venue's sanctioned way for a client to be paid for the flow it
 * brings, and it is charged to the trader's account and credited to the builder.
 *
 * Two things worth knowing before touching this:
 *
 *  - It costs the trader real money. Left at ccxt's default this fee still
 *    existed — ccxt ships `builderFee: true` with its OWN address and 1bp, and
 *    silently signs the on-chain approval during client init. So the number
 *    below is not a new charge; it is the same charge, redirected. Anything
 *    that raises `BUILDER_TENTHS_BP` IS a new charge and should be disclosed.
 *  - The approval is signed with the TRADER's key. Setting a builder means
 *    OpenWhale signs an approval on their behalf, which is exactly the
 *    mechanism people object to when they discover it. `builderFee: false` on
 *    the credential turns the whole thing off, and it is the honest answer to
 *    anyone who asks.
 *
 * The builder address must hold at least 100 USDC of perps equity or the venue
 * rejects every order carrying the code.
 */
export const BUILDER_ADDRESS = '0x929E7687eF00A577818cc5Dbd3de8Ee4e0027402'
/** Tenths of a basis point. 10 = 1.0bp — the rate ccxt was already charging. */
export const BUILDER_TENTHS_BP = 10
/** Ceiling requested in the on-chain approval; must cover BUILDER_TENTHS_BP. */
export const BUILDER_MAX_FEE_RATE = '0.01%'

export interface HyperliquidCredentials {
  walletAddress: string
  privateKey?: string
  /** Use the Hyperliquid testnet instead of mainnet. Default: false. */
  testnet?: boolean
  /** Route the builder fee elsewhere, or pass false to charge none at all. */
  builder?: string | false
}

/**
 * Hyperliquid adapter: the generic CcxtAdapter plus venue quirks.
 * Everything else (mapping, watch loops, error translation, precision)
 * is inherited.
 */
export class HyperliquidAdapter extends CcxtAdapter {
  /**
   * Quirk: ccxt double-counts the builder fee.
   *
   * Hyperliquid's fill already reports `fee` INCLUSIVE of any builder fee, and
   * reports the builder portion separately as `builderFee` for transparency.
   * ccxt's parseTrade adds the second onto the first:
   *
   *     let fee = this.safeString(trade, 'fee')
   *     const builderFee = this.safeString(trade, 'builderFee')
   *     if (builderFee !== undefined) fee = Precise.stringAdd(fee, builderFee)
   *
   * Verified against a real fill (2026-08-11): 276 @ 0.64751 = 178.7128
   * notional; base 178.7128 x 0.000432 = 0.077204, builder x 0.0001 = 0.017871,
   * and the venue's own `fee` field reads 0.095074 — the sum. So the builder
   * portion is already in there and adding it again overstates every HL fill's
   * fee by the builder rate, which at 1bp on a 4.32bp taker is ~23%.
   *
   * Subtract it back off so the PnL ledger records what the account was
   * actually charged.
   */
  override async fetchFills(symbol: string, since?: number, limit = 500): Promise<ExchangeFill[]> {
    const fills = await super.fetchFills(symbol, since, limit)
    return fills.map((f) => {
      const builder = Number((f as { info?: Record<string, unknown> }).info?.['builderFee'])
      if (f.fee === undefined || !Number.isFinite(builder) || builder === 0) return f
      return { ...f, fee: f.fee - builder }
    })
  }

  /** Hyperliquid prices order sequencing — see `priority.ts`. */
  override get supportsPriorityFee(): boolean { return true }

  private get log() { return createLogger('HyperliquidAdapter') }
  /** Keyless form (no credentials) = public data only — used by the market monitors. */
  constructor(credentials?: Partial<HyperliquidCredentials>) {
    const builder = credentials?.builder ?? BUILDER_ADDRESS
    super({
      exchangeId: 'hyperliquid',
      ...(credentials?.walletAddress ? { walletAddress: credentials.walletAddress } : {}),
      ...(credentials?.privateKey ? { privateKey: credentials.privateKey } : {}),
      ...(credentials?.testnet !== undefined ? { testnet: credentials.testnet } : {}),
      // Nested under `options`: ccxtOptions is ccxt's TOP-LEVEL config (where
      // enableRateLimit lives), while the builder settings are read out of
      // `exchange.options`. ccxt would otherwise apply its own address and
      // rate here — see BUILDER_ADDRESS.
      ccxtOptions: {
        options: builder === false
          ? { builderFee: false }
          : { builderFee: true, builder, feeInt: BUILDER_TENTHS_BP, feeRate: BUILDER_MAX_FEE_RATE },
      },
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

  /** The builder dex a market lives on ('xyz:SKHX' → 'xyz'), undefined for the main universe. */
  private hip3DexOf(symbol: string): string | undefined {
    try {
      const name = (this.exchange.market(symbol) as { info?: { name?: string } }).info?.name
      const colon = name?.indexOf(':') ?? -1
      return name !== undefined && colon > 0 ? name.slice(0, colon) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Quirk: ccxt's fetchPositions reads clearinghouseState without a dex param
   * — main universe only, so HIP-3 (builder-dex) positions are invisible: an
   * account holding only XYZ-* contracts reads as flat. Aggregate the per-dex
   * clearinghouses exactly like fetchFundingRates does. A symbols filter
   * narrows the sweep to the dexes those symbols live on (position reconciles
   * pass symbols, so the hot path costs at most one extra call); a full read
   * sweeps every builder dex. Per-dex failures are non-fatal.
   */
  override async fetchPositions(symbols?: string[]): Promise<ExchangePosition[]> {
    await this.guard(() => this.exchange.loadMarkets())
    const wantedDexes = symbols?.length
      ? [...new Set(symbols.map(s => this.hip3DexOf(s)).filter((d): d is string => d !== undefined))]
      : await this.listHip3Dexes()
    const needMain = !symbols?.length || symbols.some(s => this.hip3DexOf(s) === undefined)
    const [main, ...perDex] = await Promise.all([
      needMain ? super.fetchPositions(symbols) : Promise.resolve([] as ExchangePosition[]),
      ...wantedDexes.map(async (dex) => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const raw = await this.guard(() => this.exchange.fetchPositions(undefined, { dex })) as any[]
          return raw.map(this.mapPosition)
        } catch {
          return [] as ExchangePosition[]
        }
      }),
    ])
    const all = [...main, ...perDex.flat()]
    return symbols?.length ? all.filter(p => symbols.includes(p.symbol)) : all
  }

  /**
   * Quirk: Hyperliquid requires a price for market orders to compute the max
   * slippage bound. When absent, use the current last price and let ccxt apply
   * its default slippage tolerance.
   */
  override async createOrder(params: PerpOrderParams): Promise<ExchangeOrder> {
    if (params.type === 'market' && params.price === undefined) {
      const ticker = await this.fetchTicker(params.symbol)
      if (ticker.last > 0) return this.createOrder({ ...params, price: ticker.last })
    }
    const bps = Number(params.params?.['priorityBps'] ?? 0)
    if (bps > 0) return this.createOrderWithPriority(params, bps)
    return super.createOrder(params)
  }

  /**
   * Place an order carrying a priority fee.
   *
   * ccxt cannot express this: its Hyperliquid order action hardcodes
   * `grouping` to a string, and the priority rate rides on that same field as
   * an object. So the action is assembled here and signed with ccxt's own
   * primitives — the order object, the signature and the transport are all
   * still ccxt's, and the only thing that differs from the ordinary path is
   * the one field. `guard` and `mapOrder` bracket it so callers upstream see
   * the same error classes and the same order shape either way.
   */
  private async createOrderWithPriority(params: PerpOrderParams, bps: number): Promise<ExchangeOrder> {
    const ex = this.exchange as unknown as CcxtInternals & Record<string, unknown>
    const missing = CCXT_INTERNALS.filter(m => typeof ex[m] !== 'function')
    if (missing.length > 0) {
      // Never a reason to fail the order: the trade is worth more than the
      // sequencing it was going to buy.
      this.log.warn({ missing }, 'ccxt internals missing — placing WITHOUT priority')
      return this.placePlain(params, `ccxt internals missing: ${missing.join(', ')}`)
    }

    const tif = params.timeInForce ?? (params.type === 'market' ? 'IOC' : 'GTC')
    const budgetRaw = params.params?.['priorityBudgetUsd']
    const decision = decidePriority({
      bps,
      amount: params.amount,
      price: params.price ?? 0,
      ...(budgetRaw !== undefined ? { budgetUsd: Number(budgetRaw) } : {}),
      fallback: params.params?.['priorityFallback'] !== false,
      timeInForce: tif,
      ...(params.reduceOnly !== undefined ? { reduceOnly: params.reduceOnly } : {}),
    })

    if (!decision.attempt) {
      if (decision.fallback === false) throw new TerminalAdapterError(`priority order refused: ${decision.reason}`)
      this.log.info({ symbol: params.symbol, reason: decision.reason }, 'Priority dropped — placing plain')
      return this.placePlain(params, decision.reason ?? 'priority not attempted')
    }

    // ccxt runs this at the head of every trading method; the hand-built path
    // must too, or the builder approval never happens on a client whose first
    // order carries priority. Every step inside is flag-cached, so once warm
    // it costs nothing on the critical path.
    await this.exchange.loadMarkets()
    await ex.initializeClient()
    const orderParams: Record<string, unknown> = { timeInForce: 'Ioc' }
    if (params.clientOrderId !== undefined) orderParams['clientOrderId'] = params.clientOrderId
    // Without this the order is not reduce-only, and a close sized above what
    // is left open would flip the position instead of shutting it.
    if (params.reduceOnly !== undefined) orderParams['reduceOnly'] = params.reduceOnly

    // Hyperliquid has no market order — ccxt synthesizes one as an IOC limit
    // priced `last × (1 ± slippage)`, and it applies that bound ONLY on the
    // MARKET branch of createOrderRequest. Building the same order as a 'limit'
    // would post it AT the reference price with no room to cross: a sell at mid
    // fills only against bids at or above mid, which at the settlement instant
    // is exactly when there are none. So keep the caller's type, and supply the
    // slippage explicitly — createOrderRequest reads it from params and has no
    // default of its own (ccxt's createOrder fills it in before calling).
    const isMarket = params.type === 'market'
    if (isMarket) {
      orderParams['slippage'] = params.params?.['slippage']
        ?? (this.exchange.options as Record<string, unknown>)['defaultSlippage']
        ?? 0.05
    }

    // ccxt hands createOrderRequest STRINGS (safeString) — the market branch
    // does Precise string arithmetic on the price and throws on a number.
    // numberToString, not String(): it renders 1e-7 as 0.0000001 rather than
    // exponent notation, which Precise cannot parse.
    const num = (v: number | undefined) => (v === undefined ? undefined : ex.numberToString(v))
    const orderObj = ex.createOrderRequest(
      params.symbol, isMarket ? 'market' : 'limit', params.side,
      num(params.amount) as unknown as number, num(params.price) as unknown as number, orderParams,
    )
    const action: Record<string, unknown> = {
      type: 'order', orders: [orderObj], grouping: { p: priorityP(decision.bps!) },
    }
    // Appended AFTER grouping, matching ccxt's own field order — the action is
    // msgpack-signed, so the order of keys is part of the signature.
    const opts = this.exchange.options as Record<string, unknown>
    if (opts['approvedBuilderFee'] === true) {
      action['builder'] = {
        b: ex.safeStringLower(opts, 'builder', BUILDER_ADDRESS),
        f: Number(opts['feeInt'] ?? BUILDER_TENTHS_BP),
      }
    }

    try {
      const raw = await this.guard(async () => {
        const nonce = ex.milliseconds()
        const res = await ex.privatePostExchange({ action, nonce, signature: ex.signL1Action(action, nonce) })
        // Line-for-line with ccxt's own createOrders response handling, so the
        // two paths cannot drift apart in how a reply becomes an order.
        const statuses = ex.safeList(ex.safeDict(ex.safeDict(res, 'response', {}), 'data', {}), 'statuses', [])
        const toParse = statuses.map(s => (s === 'waitingForTrigger' ? { status: s } : s))
        return ex.parseOrders(toParse, undefined)[0]
      })
      const order = this.mapOrder(raw as never)
      return { ...order, info: { ...(order.info as object ?? {}), priorityBps: decision.bps, priorityPaid: true } }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // The undelegated stake is checked at submission, before matching. An
      // empty one at the settlement instant must not cost the whole leg.
      if (isPriorityBalanceRejection(msg) && params.params?.['priorityFallback'] !== false) {
        this.log.warn({ symbol: params.symbol }, 'Insufficient delegatable balance — placing WITHOUT priority')
        return this.placePlain(params, 'insufficient delegatable balance')
      }
      throw err
    }
  }

  /** Ordinary placement, with the reason priority was dropped recorded on the order. */
  private async placePlain(params: PerpOrderParams, reason: string): Promise<ExchangeOrder> {
    const stripped = { ...params, params: { ...params.params } }
    delete stripped.params['priorityBps']
    const order = await super.createOrder(stripped)
    return { ...order, info: { ...(order.info as object ?? {}), priorityPaid: false, priorityDroppedReason: reason } }
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
