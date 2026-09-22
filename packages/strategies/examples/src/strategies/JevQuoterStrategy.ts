import { BaseStrategy, OwStrategy, createLogger, choice } from '@openwhaleorg/core'
import type { StrategyContext, StrategyParams, Trigger, StrategyDeclarations, MonitorSource, ExecutionResult } from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { OrderBookUpdate, TradeTapeUpdate } from '@openwhaleorg/exchange'
import { z } from 'zod'
import { signedExposure } from '../indicators.js'

const log = createLogger('JevQuoter')

/**
 * One quote at a time, the side chosen by an evaluation model.
 *
 * Ported from jarrodwatts/jev-trader (MIT), which runs this shape on Monad:
 * one Jev question per block, a post-only quote on the answer's side,
 * cancelled and replaced on the next decision. What is carried over is the
 * DESIGN — a single directional question with the cost of trading written
 * into it, taker flow named as the strongest input, and a resting quote
 * rather than a market order. What is not carried over is its chain: no
 * 300ms blocks, no atomic cancel+place, no gas charged per decision.
 *
 * Why quote instead of cross, which is what `jev-scalper` does: crossing pays
 * the spread AND the taker fee on both legs, so on Hyperliquid a round trip
 * starts ~9bp underwater and the model has to find a move bigger than that in
 * seconds. Resting earns the maker side instead. The cost is real but
 * different — an unfilled quote is a missed trade, and a filled one is
 * adverse selection when the model was wrong.
 *
 * Three things the original taught this file, all of them in the question:
 *   1. the horizon is stated, and the move must BEAT THE SPREAD to count;
 *   2. taker flow is named as the strongest signal, not left to be inferred;
 *   3. when a side is capped out, the model is told so — a question whose
 *      answer cannot be acted on is a wasted call.
 *
 * Requires a `typesafe-ai` credential. Turn the instance's Dry run switch ON
 * before activating — the engine holds every instruction back while it is on,
 * which is a promise the strategy itself cannot make.
 */
const decls = {
  monitors: [
    { name: 'exchange/orderbook', label: 'book' },
    { name: 'exchange/trades', label: 'tape' },
  ],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],
} as const satisfies StrategyDeclarations

/** The quote this strategy believes is resting, so it can replace its own and no one else's. */
interface RestingQuote {
  orderId: string
  side: 'buy' | 'sell'
  price: number
  placedAt: number
}
const QUOTE_KEY = 'jev:quote'
const LAST_CALL_KEY = 'jev:lastCallTs'

@OwStrategy({
  name: { en: 'Jev Quoter (test)', 'zh-CN': 'Jev 挂单报价（测试）' },
  description: {
    en: 'An evaluation model picks a side; the strategy rests one post-only quote there and replaces it as the answer changes. Ported from jev-trader',
    'zh-CN': '评估模型选边，策略在该侧挂一张 post-only 限价单，答案变了就撤旧挂新。移植自 jev-trader',
  },
})
export class JevQuoterStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'jev-quoter'

  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  readonly baseParamsSchema = z.object({
    symbol: z.string().meta({
      displayName: 'Symbol', placeholder: 'BTC/USDC:USDC',
      catalogue: { source: 'market', kind: 'exchange/perp', marketType: 'swap' },
    }),
    quoteUsd: z.number().positive().default(50).meta({
      displayName: 'Quote Size (USD)',
      description: 'Notional of the resting order',
      i18n: { 'zh-CN': { displayName: '每张挂单名义（USD）', description: '挂出去的那张单的名义价值' } },
    }),
    maxPositionUsd: z.number().positive().default(200).meta({
      displayName: 'Max Position (USD)',
      description: 'Hard cap on |exposure|. A side at its cap is not quoted, and the model is told it is unavailable',
      i18n: { 'zh-CN': { displayName: '最大仓位（USD）', description: '|敞口| 硬上限。到顶的一侧不再报价，并会告诉模型这个方向不可用' } },
    }),
  })


  readonly tunableParamsSchema = z.object({
    horizonSec: z.number().int().min(5).default(30).meta({
      section: 'Question', displayName: 'Horizon (seconds)',
      description: 'How far ahead the model is asked to look. It is told this number, and told the move must beat the spread',
      i18n: { 'zh-CN': { displayName: '预测视野（秒）', description: '让模型预测多久之后。这个数字会写进问题里，并说明涨跌必须超过价差' } },
    }),
    minCallIntervalMs: z.number().int().min(250).default(2_000).meta({
      section: 'Question', displayName: 'Min Interval Between Judgments (ms)',
      description: 'A resting quote does not need re-deciding every tick; each decision is a request against a 1,200/min budget',
      i18n: { 'zh-CN': { displayName: '两次判断的最小间隔（毫秒）', description: '挂单不需要每个 tick 重判；每次判断都消耗每分钟 1200 次的额度' } },
    }),
    model: z.string().default('jev-latest').meta({
      section: 'Question', displayName: 'Model',
      i18n: { 'zh-CN': { displayName: '模型' } },
    }),
    minEdgeProbability: z.number().min(0.5).max(1).default(0.6).meta({
      section: 'Quoting', displayName: 'Min Side Probability',
      description: 'Below this the two sides are too close to call and no quote rests. 0.5 means always quote',
      slider: { min: 0.5, max: 0.95, step: 0.05 },
      i18n: { 'zh-CN': { displayName: '最低单边概率', description: '低于此值说明两边难分，不挂单。0.5 表示永远挂' } },
    }),
    insideTicks: z.number().int().min(0).default(0).meta({
      section: 'Quoting', displayName: 'Ticks Inside the Touch',
      description: '0 joins the best bid/ask. Deeper inside fills sooner and earns less of the spread',
      i18n: { 'zh-CN': { displayName: '比盘口内移几跳', description: '0 = 与买一/卖一同价。越往里越容易成交，赚到的价差越少' } },
    }),
    replaceBps: z.number().min(0).default(1).meta({
      section: 'Quoting', displayName: 'Replace When Price Moves (bps)',
      description: 'A resting quote is left alone until the touch has moved this far — every replacement is two venue calls',
      i18n: { 'zh-CN': { displayName: '价格移动多少 bp 才换单', description: '盘口没走到这个幅度就不动已挂的单——每次换单是两次交易所调用' } },
    }),
    maxQuoteAgeSec: z.number().int().min(1).default(60).meta({
      section: 'Quoting', displayName: 'Max Quote Age (seconds)',
      description: 'A quote older than this is replaced even if nothing moved: the judgment behind it has expired',
      i18n: { 'zh-CN': { displayName: '挂单最长存活（秒）', description: '超过这个时间即使盘口没动也换单：背后那次判断已经过期' } },
    }),
  })

  private key(params: StrategyParams): string {
    const { symbol } = this.baseParamsSchema.parse(params.base)
    return `${this.accountVenue('main')}:${symbol}`
  }

  override subscriptions(params: StrategyParams): MonitorSource[] {
    return [
      { monitorName: this.monitor('book'), key: this.key(params) },
      { monitorName: this.monitor('tape'), key: this.key(params) },
    ]
  }

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return [{
      enabled: true,
      conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('book'), key: this.key(params) }] }],
    }]
  }

  /** Remember the venue id of the quote we just placed, so the next cycle can replace it. */
  override async onExecutionResult(result: ExecutionResult): Promise<void> {
    if (result.status !== 'success') return
    const params = result.instruction.params as { side?: string; price?: number } | undefined
    const data = result.data as { orderId?: string } | undefined
    if (result.instruction.action !== 'placeOrder' || !data?.orderId || !params?.side) return
    await this.store.set<RestingQuote>(QUOTE_KEY, {
      orderId: data.orderId,
      side: params.side === 'buy' ? 'buy' : 'sell',
      price: params.price ?? 0,
      placedAt: Date.now(),
    })
  }

  async evaluate(context: StrategyContext): Promise<ReturnType<BaseStrategy['instruction']>[]> {
    const { symbol, quoteUsd, maxPositionUsd } = this.baseParamsSchema.parse(this.params.base)
    const t = this.tunableParamsSchema.parse(this.params.tunable)
    const key = this.key(this.params)

    const book = context.getData('book', key) as OrderBookUpdate | undefined
    if (!book || !(book.mid > 0) || !(book.bestBid > 0) || !(book.bestAsk > 0)) return []

    const positions = await this.account('main').positions()
    const exposure = signedExposure(positions, symbol)
    // A side at its cap cannot be acted on, so the model is told it is closed
    // rather than asked a question whose answer must be thrown away.
    const allowed = {
      buy: exposure < maxPositionUsd,
      sell: exposure > -maxPositionUsd,
    }
    if (!allowed.buy && !allowed.sell) {
      this.trace('capped:both', { exposure, maxPositionUsd })
      return []
    }

    const resting = await this.store.get<RestingQuote>(QUOTE_KEY)
    const tick = this.tickOf(book)
    const wanted = (side: 'buy' | 'sell'): number => side === 'buy'
      ? book.bestBid + tick * t.insideTicks
      : book.bestAsk - tick * t.insideTicks

    // ── is a fresh judgment worth its request? ──────────────────────────
    const now = Date.now()
    const lastCall = (await this.store.get<number>(LAST_CALL_KEY)) ?? 0
    const ageSec = resting ? (now - resting.placedAt) / 1000 : Infinity
    const drifted = resting
      ? Math.abs(wanted(resting.side) - resting.price) / book.mid * 10_000 >= t.replaceBps
      : true
    if (now - lastCall < t.minCallIntervalMs) return []
    if (resting && !drifted && ageSec < t.maxQuoteAgeSec) {
      this.trace('quote:still-good', { side: resting.side, price: resting.price, ageSec: Math.round(ageSec) })
      return []
    }

    const tape = context.getData('tape', key) as TradeTapeUpdate | undefined
    const cvd = tape ? tape.buyVolume - tape.sellVolume : 0

    /*
     * The state the original sends, in the shapes we have: the touch, depth
     * per side, the top levels, the taker flow over the window, and what the
     * position allows. Nothing else — accuracy falls as irrelevant context
     * grows, and every token is paid for.
     */
    const state = {
      market: symbol,
      horizon_seconds: t.horizonSec,
      mid: book.mid,
      spread_bps: round(book.spreadBps, 3),
      book_imbalance: round(book.imbalance, 4),
      depth: { bid: round(book.bidVolume, 4), ask: round(book.askVolume, 4) },
      book: {
        bids: book.bids.slice(0, 5).map(([p, a]) => `${p} x ${a}`),
        asks: book.asks.slice(0, 5).map(([p, a]) => `${p} x ${a}`),
      },
      trades: tape
        ? {
            window_ms: tape.windowEnd - tape.windowStart,
            count: tape.tradeCount,
            buy_volume: round(tape.buyVolume, 4),
            sell_volume: round(tape.sellVolume, 4),
            cvd: round(cvd, 4),
            vwap_vs_mid_bps: round(((tape.vwap - book.mid) / book.mid) * 10_000, 2),
          }
        : null,
      position: { exposure_usd: round(exposure, 2), max_usd: maxPositionUsd },
      allowed,
    }

    const started = Date.now()
    const { answers, usage, model } = await this.judge({
      state,
      model: t.model,
      questions: {
        direction: choice(
          {
            question: `Will ${symbol} be higher or lower than the current mid in about ${t.horizonSec} seconds?`,
            goal: 'A post-only quote will rest on the chosen side and be replaced when this answer changes. '
              + 'The move must beat `spread_bps` for the trade to be worth making.',
            timing: 'The order rests at the touch; it earns the maker side if someone crosses into it.',
            inputs: 'Taker flow is the strongest signal: `trades.cvd` (taker buys minus taker sells over the window) '
              + 'and `trades.vwap_vs_mid_bps` show who is hitting the book. `depth` and `book` show resting liquidity '
              + 'per side — thin depth on one side means price moves that way more easily. '
              + 'If `allowed.buy` is false the quote will be a sell regardless, and vice versa.',
          },
          {
            buy: 'Higher: rest a bid. The mid is more likely above its current level after the horizon, by more than the spread.',
            sell: 'Lower: rest an offer. The mid is more likely below its current level after the horizon, by more than the spread.',
          },
        ),
      },
    })
    await this.store.set(LAST_CALL_KEY, now)

    const p = answers.direction.probabilities
    let side: 'buy' | 'sell' = answers.direction.choice === 'buy' ? 'buy' : 'sell'
    const edge = side === 'buy' ? p.buy : p.sell
    const verdict = {
      side, pBuy: round(p.buy, 3), pSell: round(p.sell, 3),
      confidence: round(answers.direction.confidence, 3),
      model, latencyMs: Date.now() - started, inputTokens: usage.input_tokens,
    }
    this.trace('judgment', verdict)
    log.info({ symbol, ...verdict, exposure }, 'Jev quote decision')

    // The cap overrides the answer rather than the answer being re-asked.
    if (!allowed[side]) side = side === 'buy' ? 'sell' : 'buy'
    if (edge < t.minEdgeProbability) {
      this.trace('skip:no-edge', { edge, min: t.minEdgeProbability })
      // An expired quote still comes down: it was placed on a judgment that no longer holds.
      return resting && ageSec >= t.maxQuoteAgeSec ? [this.cancel(resting, symbol)] : []
    }

    const price = wanted(side)
    if (resting && resting.side === side && Math.abs(price - resting.price) / book.mid * 10_000 < t.replaceBps && ageSec < t.maxQuoteAgeSec) {
      this.trace('quote:unchanged', { side, price })
      return []
    }

    const instructions: ReturnType<BaseStrategy['instruction']>[] = []
    // Cancel first, then place: without the venue's atomic replace, the
    // alternative is briefly resting twice the intended size.
    if (resting) instructions.push(this.cancel(resting, symbol))
    instructions.push(this.instruction('perp', 'placeOrder', {
      symbol,
      side,
      type: 'limit',
      price,
      amount: quoteUsd / price,
      timeInForce: 'PO',
    }, ['main']))
    return instructions
  }

  private cancel(resting: RestingQuote, symbol: string) {
    return this.instruction('perp', 'cancelOrder', { orderId: resting.orderId, symbol }, ['main'])
  }

  /** The venue's tick, read off the book rather than configured: the levels are already on it. */
  private tickOf(book: OrderBookUpdate): number {
    const levels = [...book.bids.map(([p]) => p), ...book.asks.map(([p]) => p)].sort((a, b) => a - b)
    let smallest = book.spread
    for (let i = 1; i < levels.length; i++) {
      const gap = levels[i]! - levels[i - 1]!
      if (gap > 0 && gap < smallest) smallest = gap
    }
    return smallest > 0 ? smallest : book.mid * 1e-5
  }
}

const round = (v: number, digits: number): number => Number(v.toFixed(digits))
