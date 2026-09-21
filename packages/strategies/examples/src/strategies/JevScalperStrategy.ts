import { BaseStrategy, OwStrategy, createLogger, choice, noul } from '@openwhaleorg/core'
import type { StrategyContext, StrategyParams, Trigger, StrategyDeclarations, MonitorSource } from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { OrderBookUpdate, TradeTapeUpdate } from '@openwhaleorg/exchange'
import { z } from 'zod'
import { signedExposure, sizeAgainstCap } from '../indicators.js'

const log = createLogger('JevScalper')

/**
 * Judgment on the tape — an evaluation model in a fast loop.
 *
 * A chat model cannot sit in a one-second loop: it writes an answer a token
 * at a time and charges for every one. An EVALUATION model answers questions
 * instead. TypeSafe's Jev takes a state and a map of questions, answers all
 * of them in parallel, and returns probabilities — no prose, no reasoning
 * chain, and (their published cookbook, 13 questions over a 54k-character
 * state) a few hundred milliseconds. That is what makes this loop possible.
 *
 * It is NOT a tick-by-tick predictor, and this strategy does not pretend
 * otherwise:
 *
 *   - Every decision costs a round trip over the public internet. Sub-second
 *     is reachable, sub-millisecond is not. Microstructure arithmetic belongs
 *     in code; the model is asked only what code reads badly — whether a
 *     book and a tape AGREE, and whether what just happened looks like a
 *     one-off print or the start of something.
 *   - The venue's budget is 1,200 requests a minute. `minCallIntervalMs`
 *     (default one second) is what keeps a per-tick monitor from spending it,
 *     and a cheap code-side gate decides whether a tick is worth asking about
 *     at all. Most ticks are not.
 *
 * The division of labour is the same as the AI analyst example: the model
 * names a direction and a probability, the CODE owns the size, the cap and
 * the cooldown. A model that is wrong should cost a clip, never the account.
 *
 * Requires a `typesafe-ai` credential (Credentials → TypeSafe (Jev)).
 * Dry run by default — leave it that way until the trace reads sensibly.
 */
const decls = {
  monitors: [
    { name: 'exchange/orderbook', label: 'book' },
    { name: 'exchange/trades', label: 'tape' },
  ],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],
} as const satisfies StrategyDeclarations

/** Where the last judgment was asked for, so the cooldown survives a restart. */
const LAST_CALL_KEY = 'jev:lastCallTs'

@OwStrategy({
  name: { en: 'Jev Tape Scalper (test)', 'zh-CN': 'Jev 盘口判断（测试）' },
  description: {
    en: 'An evaluation model judges book and tape agreement once a second; code owns size, caps and cooldown. A test bed for Jev in a fast loop, not a production edge',
    'zh-CN': '用评估模型每秒判断一次盘口与成交流是否一致；仓位、上限和冷却全部由代码控制。用于测试 Jev 在快循环中的表现，不是成熟策略',
  },
})
export class JevScalperStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'jev-scalper'

  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  readonly baseParamsSchema = z.object({
    symbol: z.string().meta({
      displayName: 'Symbol', placeholder: 'BTC/USDT:USDT',
      catalogue: { source: 'market', kind: 'exchange/perp', marketType: 'swap' },
    }),
    notionalUsd: z.number().positive().default(50).meta({
      displayName: 'Max Order Notional (USD)',
      description: 'Clip at full conviction — the probability scales down from here, never up',
      i18n: { 'zh-CN': { displayName: '单笔最大名义（USD）', description: '满信心时的单笔规模——概率只会往下缩，不会放大' } },
    }),
    maxPositionUsd: z.number().positive().default(200).meta({
      displayName: 'Max Position (USD)',
      description: 'Hard cap on |exposure|, enforced in code whatever the model says',
      i18n: { 'zh-CN': { displayName: '最大仓位（USD）', description: '|敞口| 硬上限，无论模型说什么都由代码强制' } },
    }),
    dryRun: z.boolean().default(true).meta({
      displayName: 'Dry Run', i18n: { 'zh-CN': { displayName: '模拟运行' } },
    }),
  })

  readonly tunableParamsSchema = z.object({
    minCallIntervalMs: z.number().int().min(250).default(1_000).meta({
      section: 'Budget', displayName: 'Min Interval Between Judgments (ms)',
      description: 'The venue allows 1,200 requests a minute across the account. One second is 60 — room to spare and money spent on ticks that matter',
      i18n: { 'zh-CN': { displayName: '两次判断的最小间隔（毫秒）', description: '交易所限额每分钟 1200 次；1 秒一次即每分钟 60 次，留足余量' } },
    }),
    minImbalance: z.number().min(0).max(1).default(0.25).meta({
      section: 'Budget', displayName: 'Ask Only Above Imbalance',
      description: 'Code-side gate: a balanced book has nothing to judge, and asking anyway is what makes this expensive',
      slider: { min: 0, max: 1, step: 0.05 },
      i18n: { 'zh-CN': { displayName: '失衡度达到多少才提问', description: '代码侧闸门：盘口均衡时没什么可判断的，照问就是浪费' } },
    }),
    maxSpreadBps: z.number().min(0).default(5).meta({
      section: 'Budget', displayName: 'Max Spread (bps)',
      description: 'Above this the round trip cannot pay for itself, so neither the model nor the order is worth it',
      i18n: { 'zh-CN': { displayName: '最大价差（bp）', description: '超过这个价差，一来一回赚不回成本，模型和下单都不值得' } },
    }),
    minFollowThrough: z.number().min(0).max(1).default(0.65).meta({
      section: 'Conviction', displayName: 'Min Follow-through Probability',
      description: 'Jev’s probability that the pressure continues rather than fades',
      slider: { min: 0.5, max: 0.95, step: 0.05 },
      i18n: { 'zh-CN': { displayName: '最低延续概率', description: 'Jev 判断这股压力会延续而不是消退的概率' } },
    }),
    minConfidence: z.number().min(0).max(1).default(0.6).meta({
      section: 'Conviction', displayName: 'Min Direction Confidence',
      description: 'How peaked the direction answer must be. Calibrated: 0.8 should be right about 80% of the time, over many calls',
      slider: { min: 0, max: 1, step: 0.05 },
      i18n: { 'zh-CN': { displayName: '最低方向置信度', description: '方向判断的集中程度。该概率是校准过的：0.8 在大量样本上约有 80% 正确率' } },
    }),
    maxNoise: z.number().min(0).max(1).default(0.4).meta({
      section: 'Conviction', displayName: 'Max "Just Noise" Probability',
      description: 'A veto question. High here means the print looks like a one-off, whatever the direction says',
      slider: { min: 0, max: 1, step: 0.05 },
      i18n: { 'zh-CN': { displayName: '「只是噪音」概率上限', description: '否决项：这个值高说明只是偶发成交，方向判断再强也不做' } },
    }),
    model: z.string().default('jev-latest').meta({
      section: 'Conviction', displayName: 'Model',
      description: 'Pin a version (e.g. jev-1.13.0) once the thresholds above are tuned — an alias moves under you',
      i18n: { 'zh-CN': { displayName: '模型', description: '阈值调好后建议钉住具体版本（如 jev-1.13.0），别名会随发布变动' } },
    }),
    slippage: z.number().min(0).default(0.001).meta({
      section: 'Execution', displayName: 'Slippage', i18n: { 'zh-CN': { displayName: '滑点' } },
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

  /** Every book update is a candidate; the gates below decide which one costs a judgment. */
  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return [{
      enabled: true,
      conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('book'), key: this.key(params) }] }],
    }]
  }

  async evaluate(context: StrategyContext): Promise<ReturnType<BaseStrategy['instruction']>[]> {
    const { symbol, notionalUsd, maxPositionUsd, dryRun } = this.baseParamsSchema.parse(this.params.base)
    const t = this.tunableParamsSchema.parse(this.params.tunable)
    const key = this.key(this.params)

    const book = context.getData('book', key) as OrderBookUpdate | undefined
    if (!book || !(book.mid > 0)) { this.trace('book:absent', { key }); return [] }

    // ── code-side gates, before a single token is spent ──────────────────
    if (book.spreadBps > t.maxSpreadBps) {
      this.trace('gate:spread', { spreadBps: book.spreadBps, max: t.maxSpreadBps })
      return []
    }
    if (Math.abs(book.imbalance) < t.minImbalance) {
      this.trace('gate:balanced', { imbalance: book.imbalance, min: t.minImbalance })
      return []
    }
    const now = Date.now()
    const lastCall = (await this.store.get<number>(LAST_CALL_KEY)) ?? 0
    if (now - lastCall < t.minCallIntervalMs) {
      this.trace('gate:cooldown', { sinceMs: now - lastCall, min: t.minCallIntervalMs })
      return []
    }

    const tape = context.getData('tape', key) as TradeTapeUpdate | undefined
    const positions = await this.account('main').positions()
    const exposure = signedExposure(positions, symbol)

    /*
     * The state is numbers the model can compare, not prose about them.
     * Jev loses accuracy as irrelevant context grows ("context rot" in their
     * own docs), so this carries the book, the tape and the exposure and
     * nothing else — no candle history, no account chatter.
     */
    const state = {
      symbol,
      book: {
        mid: book.mid,
        spread_bps: round(book.spreadBps, 3),
        imbalance: round(book.imbalance, 4),
        bid_volume: round(book.bidVolume, 4),
        ask_volume: round(book.askVolume, 4),
      },
      tape: tape
        ? {
            window_ms: tape.windowEnd - tape.windowStart,
            trades: tape.tradeCount,
            buy_ratio: round(tape.buyRatio, 4),
            volume: round(tape.volume, 4),
            vwap_vs_mid_bps: round(((tape.vwap - book.mid) / book.mid) * 10_000, 2),
          }
        : null,
      position: { exposure_usd: round(exposure, 2), max_usd: maxPositionUsd },
    }

    const started = Date.now()
    const { answers, usage, model } = await this.judge({
      state,
      model: t.model,
      questions: {
        // One round trip, three questions: they are answered in parallel, so
        // the second and third cost tokens but almost no time.
        direction: choice(
          'Taking `book.imbalance`, `tape.buy_ratio` and `tape.vwap_vs_mid_bps` together, which side is pressing this market right now?',
          {
            buyers: 'Bids are stacked and aggressive buying is lifting the offer',
            sellers: 'Offers are stacked and aggressive selling is hitting the bid',
            neither: 'The two disagree, or the pressure is too weak to call',
          },
        ),
        followThrough: noul(
          'Will this pressure carry the mid price further in the same direction over the next few seconds, rather than fading straight back?',
        ),
        noise: noul(
          'Is what `tape` shows a one-off print or a spread artifact, rather than genuine directional flow?',
        ),
      },
    })
    await this.store.set(LAST_CALL_KEY, now)

    const verdict = {
      side: answers.direction.choice,
      confidence: round(answers.direction.confidence, 3),
      follow: round(answers.followThrough.noul, 3),
      noise: round(answers.noise.noul, 3),
      model,
      latencyMs: Date.now() - started,
      inputTokens: usage.input_tokens,
    }
    this.trace('judgment', verdict)
    log.info({ symbol, ...verdict, imbalance: book.imbalance }, 'Jev judgment')

    if (verdict.side === 'neither') return []
    if (verdict.confidence < t.minConfidence) { this.trace('skip:confidence', verdict); return [] }
    if (verdict.follow < t.minFollowThrough) { this.trace('skip:follow', verdict); return [] }
    if (verdict.noise > t.maxNoise) { this.trace('skip:noise', verdict); return [] }

    // Conviction scales the clip; the cap has the final word.
    const direction: 1 | -1 = verdict.side === 'buyers' ? 1 : -1
    const wanted = notionalUsd * verdict.follow
    const { allowedUsd, reduceOnly } = sizeAgainstCap(wanted, exposure, direction, maxPositionUsd)
    if (allowedUsd <= 0) {
      this.trace('sized-out', { wanted, exposure, maxPositionUsd })
      return []
    }

    return [this.instruction('perp', 'placeOrder', {
      symbol,
      side: direction > 0 ? 'buy' : 'sell',
      type: 'market',
      amount: allowedUsd / book.mid,
      ...(reduceOnly ? { reduceOnly: true } : {}),
      slippage: t.slippage,
      dryRun,
    }, ['main'])]
  }
}

const round = (v: number, digits: number): number => Number(v.toFixed(digits))
