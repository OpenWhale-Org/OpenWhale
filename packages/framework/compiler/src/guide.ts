/**
 * The framework-writing guide injected into agent prompts. Hand-maintained;
 * update when strategy-facing core APIs change.
 */
export const FRAMEWORK_GUIDE = `
# OpenWhale generated-code rules

You write TypeScript for the OpenWhale trading framework. Components are loaded
by id from a registry; generated code references EXISTING components by their
FULL registry key (e.g. 'hyperliquid/user-trades', 'exchange/perp-trading') —
never invent ids.

## Strategy (the usual deliverable)

- Extend BaseStrategy with TYPED DECLS style (never decorators — the type
  checker must see the labels):

\`\`\`typescript
import { BaseStrategy } from '@openwhaleorg/core'
import type { StrategyContext, StrategyParams, Trigger, StrategyDeclarations, ExecutionInstruction } from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import { z } from 'zod'

const decls = {
  monitors: [{ name: 'hyperliquid/user-trades', label: 'trades' }],  // full registry keys
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],               // Reader CLASS reference
  // Declare an llm slot ONLY when the strategy itself needs model inference:
  llms: [{ label: 'decision', model: 'anthropic:claude-haiku-4-5' }],
} as const satisfies StrategyDeclarations

export default class GeneratedStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'my-strategy'          // will be overridden at approval; keep it set
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  readonly baseParamsSchema = z.object({       // required config (no defaults)
    symbol: z.string().meta({ displayName: 'Symbol', placeholder: 'BTC/USDC:USDC' }),
  })
  readonly tunableParamsSchema = z.object({    // optimizable knobs (ALL have .default())
    threshold: z.number().default(0.05).meta({ displayName: 'Threshold' }),
  })

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    // cron: { type: 'cron', expression: '*/5 * * * *' }
    // monitor, raw key:    { type: 'monitor', sources: [{ monitorName: this.monitor('trades'), key: <emit key> }] }
    // monitor, STRUCTURED (preferred when the monitor declares a keySchema —
    // fields are validated and composed into the key by the framework):
    //   { type: 'monitor', sources: [{ monitorName: this.monitor('trades'), key: '', keyParams: { address: params.base['target'] } }] }
    return [{ enabled: true, conditions: [{ type: 'cron', expression: '* * * * *' }] }]
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const { symbol } = this.baseParamsSchema.parse(this.params.base)
    const { threshold } = this.tunableParamsSchema.parse(this.params.tunable)
    const account = this.account('main')       // typed Reader — READ ONLY
    const positions = await account.positions()
    const data = context.getData('trades', 'someKey')  // monitor payload (if monitor-triggered)
    // decide…
    return [this.instruction('perp', 'placeOrder', { symbol, side: 'buy', type: 'market', amount: 0.01 }, ['main'])]
  }
}
\`\`\`

- HARD RULES:
  1. Strategies are strictly READ-ONLY. Never call any order/trade method —
     express all execution as this.instruction(executorLabel, action, params,
     [accountLabels]). Never import venue SDKs, ccxt, or fetch trading APIs.
  2. instruction action/params MUST match the target executor's actionSchemas
     exactly (schemas are provided in the component list).
  3. NEVER define Reader/Account classes. Only reference provided Reader
     classes (e.g. PerpAccount from '@openwhaleorg/exchange'). If required
     data is not on the Reader, report it as a gap instead.
  4. Export the class as BOTH \`export default\` AND keep it named.
  5. this.http is for PUBLIC data only. this.store is a persistent KV.
     For model inference declare an llms slot and call
     this.llm('<label>', { messages, schema }) — users rebind the slot's
     model/credential per instance from the dashboard; do NOT put model ids
     in params. Also declare \`override readonly llms = decls.llms\`.
  6. Amounts are BASE units, not USD. Convert notional via ticker price.

## Reader (account) API — PerpAccount (kind 'exchange/perp')

balance(): {usd:{available,total}, tokens[]} · positions(): {id,side,value,pnl}[]
orders() · pnl() · history(limit) · fetchBalance/fetchPositions/fetchPosition/
fetchOpenOrders/fetchOrders/fetchOrder/fetchMyTrades (raw venue shapes) ·
fetchTicker/fetchOrderBook/fetchOHLCV/fetchTrades/fetchFundingRate(s) (market data)

## Monitor (only when analysis approved generating one)

Extend BaseMonitor<string, TData>; implement monitorName, emitSchema (zod),
keySchema (zod — the key's field structure), mode (MonitorMode.Subscribe),
startSubscribe/stopSubscribe; deliver data with await this.push(key, data).
Monitors hold NO credentials — public data only (HTTP/WebSocket).

If the source can serve HISTORY (klines, funding history, any "last N"
endpoint), also implement the optional backfill hook — the framework calls it
on a key's first subscribe, before live collection:

  protected override async backfill(key, since: number | undefined, signal)
    : Promise<Array<{ ts: number; data: TData }>>

The "since" argument is the newest already-stored ts (undefined when cold) —
fetch only the gap. Return ascending records whose ts is WHEN THE VALUE BECAME
TRUE (a candle's close time). History is persisted WITHOUT firing triggers;
throwing is non-fatal. Derived signals must be reconstructed walk-forward (fit
each point only on data before it) or the backfilled curve won't match the
live one.

## Executor (only when analysis approved generating one — carries FULL write power)

Extend BaseExecutor; implement executorName, supportedActions, actionSchemas
(zod params per action), credentials (slots: [{label, kind}] using EXISTING
kinds only), execute(instruction) using this.session<T>(label). File must start
with a comment warning that this code holds write-capable venue sessions.
`
