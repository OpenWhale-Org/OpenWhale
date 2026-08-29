# Writing a Strategy

A strategy declares its dependencies (monitors, executors, account slots), its params (two Zod
schemas), its triggers, and one decision function `evaluate()`. The runtime handles subscription
lifecycle, param validation, account materialization, and instruction routing.

## Complete template

```ts
import { z } from 'zod'
import { BaseStrategy, OwStrategy, createLogger } from '@openwhaleorg/core'
import type {
  ExecutionInstruction, StrategyContext, StrategyParams, Trigger, StrategyDeclarations,
} from '@openwhaleorg/core'
import { PerpAccount } from '@openwhaleorg/exchange'
import type { FundingSnapshot } from '@openwhaleorg/exchange'

const log = createLogger('MyStrategy')

// Declarations: `as const satisfies StrategyDeclarations` gives typed labels everywhere.
const decls = {
  monitors: [
    { name: 'exchange/funding-rates', label: 'rates' },   // another plugin's contract → qualified id
  ],
  executors: [
    { name: 'exchange/perp-trading', label: 'trade' },    // the shared perp executor
  ],
  accounts: [
    { account: PerpAccount, label: 'main' },              // class reference = the read-view type you get
  ],
} as const satisfies StrategyDeclarations

@OwStrategy({ name: 'My Strategy', description: 'One-line description shown in the Dashboard' })
export class MyStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'my-strategy'

  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  // Required params, no defaults. NEVER include a venue field — it derives from the account slot.
  readonly baseParamsSchema = z.object({
    capitalUsd: z.number().positive()
      .meta({ displayName: 'Capital (USD)', placeholder: '1000' }),
    dryRun: z.boolean().default(true)
      .meta({ displayName: 'Dry Run', description: 'Simulate instead of placing orders' }),
  })

  // Tunables: EVERY field needs .default(). These are what the user (or an optimizer) tweaks.
  readonly tunableParamsSchema = z.object({
    minAbsRate: z.number().min(0).default(0.001)
      .meta({ displayName: 'Min |Funding Rate|' }),
    maxPositions: z.number().int().positive().default(3)
      .meta({ displayName: 'Max Positions' }),
  })

  triggers(_params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    // Injected BEFORE triggers(): the venue of the bound account.
    const venue = this.accountVenue('main')
    return [
      {
        enabled: true,
        conditions: [{
          type: 'monitor',
          sources: [{ monitorName: this.monitor('rates'), key: venue }],
        }],
      },
    ]
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const venue = this.accountVenue('main')
    const snapshot = context.getData('rates', venue) as FundingSnapshot | undefined
    if (!snapshot) return []

    const { capitalUsd, dryRun } = this.baseParamsSchema.parse(this.params.base)
    const t = this.tunableParamsSchema.parse(this.params.tunable)

    // Read view of the bound account — typed as PerpAccount, structurally read-only.
    const account = this.account('main')
    const balance = await account.balance()

    // Idempotency via the per-instance KV store (persisted in SQLite).
    const actedKey = `acted:${venue}:${snapshot.timestamp}`
    if (await this.store.has(actedKey)) { this.trace('already-acted', { actedKey }); return [] }
    await this.store.set(actedKey, Date.now())
    this.trace('signal', { venue, contracts: snapshot.rates.length })   // every gate leaves a step; a silent run is a bug

    void capitalUsd; void t; void balance
    log.info({ venue }, 'Emitting instruction')

    // instruction(executorLabel, action, params, accountLabels)
    // accountLabels routes the executor's slots to THIS strategy's bound accounts.
    return [this.instruction('trade', dryRun ? 'simulate' : 'placeOrder', {
      symbol: 'BTC/USDT:USDT', side: 'buy', notionalUsd: 100,
    }, ['main'])]
  }
}
```

## The API you have inside a strategy

| Member | What it gives you |
|---|---|
| `this.params` | `{ base, tunable }` raw objects — parse with your schemas for typing + defaults |
| `this.account('label')` | The account slot's read view, typed as the declared class |
| `this.accountVenue('label')` / `this.accountMeta('label')` | Bound account's venue — its cell's venue (`'binance'`, `'boros'`; equals the credential type only for venue-issued keys) / full `{label, accountName, venue, kind}` |
| `this.monitor('label')` / `this.executor('label')` | Validated label, for triggers / rarely needed directly |
| `this.monitorData('label')` | A `MonitorDataReader` for historical data: `keys() / readLast(key,n) / readAll(key) / readLatest(key) / readRange(key,from,to) / count(key) / stream(key) / readAllLatest() / readAllLast(n)` — records are `{ ts, data }`. `readAll` returns the whole stored history with no cap: prefer it over a large `readLast` when a fit needs every sample, since a windowed read silently truncates the evidence |
| `this.instruction(execLabel, action, params, accountLabels?)` | Build a serializable `ExecutionInstruction` |
| `this.store` | Per-instance async KV: `get/set/has/delete/keys/clear` — survives restarts |
| `this.credential(name)` | Read a credential by name (needs explicit user binding — avoid unless necessary) |
| `this.llm(...)` / `llms` declaration | LLM slots — declare `{ label, model: 'provider:model', credentialName?, settings? }` in `decls.llms`; call `this.llm('label', { messages, schema? })` (a `schema` returns the parsed object, no schema returns text; the label is omissible with exactly one slot). Config merges declaration ← instance binding ← call options. `this.llmModel('label')` hands you the raw AI-SDK model for anything the wrapper doesn't cover |
| `context.getData(label, key)` | The emitted record that fired this trigger (undefined for other labels/keys) |
| `this.addMonitorSource(label, key, { trigger? })` | Start collecting a monitor key discovered at RUNTIME (e.g. an auto-detected pair's feed); `trigger: true` also wakes `evaluate` on its pushes. Returns false on runtimes without dynamic-source support; idempotence is your job |
| `this.trace(step, data?)` | Record one decision step of the current run. The Dashboard shows the trace per run and it survives restarts; `GET /api/instances/{id}/runs` returns them. Call it at EVERY gate — `this.trace('rate-below-min', { rate, min })` before `return []` — so a run that emitted nothing still says which condition refused. No-op outside `run()` |
| `this.rule(cond, instructions)` / `this.parallel(sets)` | `rule` returns the instructions only when `cond` holds (else `[]`); `parallel` flattens several instruction sets. Sugar for readable `evaluate` bodies |
| `availabilityCheckers` | `Readonly<Record<name, AvailabilityChecker>>` — pure functions over the venue's market list, named from a param's `.meta({ availability: { checker } })`. The built-in `availability: { source: 'market', kind? }` needs no checker: every value must be a listed market |

## Trigger shapes

```ts
// PREFERRED — structured keyParams, validated against the contract's keySchema and composed
// into the key at activation. This is also what lets keySchema dispatch pick a specialized
// implementation; a plain string key cannot be routed when several implementations coexist.
{ enabled: true, conditions: [{ type: 'monitor', sources: [{
    monitorName: this.monitor('rates'), key: '', keyParams: { venue },
}]}]}

// Plain string key (single-field keySchema or a key you built with the same ':' join)
{ enabled: true, conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('rates'), key: venue }] }] }

// Filtered: only when a field of the emitted record passes
{ enabled: true, conditions: [{ type: 'monitor', sources: [{
    monitorName: this.monitor('rates'), key: venue,
    filter: { field: 'msToSettlement', op: 'lt', value: 3_600_000 },
}]}]}

// Cron: time-based (no monitor involved)
{ enabled: true, conditions: [{ type: 'cron', expression: '*/5 * * * *' }] }
```

A trigger with multiple monitor declarations fires on ANY of them; `evaluate()` distinguishes which
via `context.getData(label, key)` returning non-undefined. When one strategy has several data
sources (e.g. a decision feed + a stats feed), give each its own trigger and branch in `evaluate()`.

## Multi-slot / multi-account strategies

Declare more slots — the instance form binds each:

```ts
accounts: [
  { account: PerpAccount, label: 'long' },
  { account: PerpAccount, label: 'short' },
],
```

`this.instruction('trade', 'x', p, ['long'])` routes to the account bound to `long`. Different
slots may be bound to different venues; `this.accountVenue('long')` tells you which.

## Symbol params get a picker

Any param holding a venue symbol should carry a `catalogue` marker so the instance form renders a
searchable market picker instead of a text box. Strategy params have **no venue field** (rule 5),
so omit `venueField` — the form sources the venue from the bound account:

```ts
symbolA: z.string().meta({
  displayName: 'Symbol A',
  placeholder: 'BZ/USDT:USDT',
  catalogue: { source: 'market', kind: 'exchange/perp', marketType: 'swap' },
}),
```

Free text still submits, so an unlisted symbol never blocks the form. See `references/monitor.md`
§Symbol fields for the full contract. Non-exchange kinds use the same marker with their own kind
(`catalogue: { source: 'market', kind: 'pendle/rates' }`) — the venue's session must implement the
catalogue read (`fetchMarkets`) for the picker to list anything.

## Illustrating params

A param whose meaning is geometric (a band, a timeline, a ladder) is easier to set with a picture
that moves as the field changes. Declare `paramsIllustrations` on the strategy class — each entry is
a self-contained HTML page rendered in a sandboxed iframe under its `section`'s fields, receiving the
live values via `postMessage`:

```ts
import type { ParamIllustration } from '@openwhaleorg/core'

const CORRIDOR_HTML = `<!doctype html><html><body><svg id="s"></svg><script>
var v = {};
function draw() { var edge = parseFloat(v.edgeRatio) || 0.95; /* draw with plain string concat */ }
window.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'ow-params') { v = e.data.values || {}; draw(); }
});
window.addEventListener('resize', draw); draw();
</script></body></html>`

export const illustrations: ParamIllustration[] = [
  { section: 'Corridor', title: 'Where orders rest', html: CORRIDOR_HTML, height: 225 },   // section matches .meta({ section })
]
// in the class:  readonly paramsIllustrations = illustrations
```

Compute layout from the iframe's real width on every draw (a fixed viewBox stretches text), keep the
page dependency-free, and write it in plain string concatenation — the page is data shipped inside
the plugin, not code with two escape layers.

## Presets

A strategy with many knobs usually has a few configurations worth naming. Declare them as
`paramPresets` on the class and the instance form shows a **Preset** dropdown (placeholder
"— custom —") above the fields. Choosing one sets every field the preset names — `base` and
`tunable` — and leaves the rest as they are, so a preset may be partial; the operator can still edit
any field afterwards. Presets are seeds for the form only: they are not validated at registration
and never applied at activation.

```ts
import type { ParamPreset } from '@openwhaleorg/core'

override readonly paramPresets: ParamPreset[] = [
  { id: 'paper', label: 'Paper', description: 'Tiny size, wide stops', tunable: { sizeUsd: 10, stopPct: 5 } },
  { id: 'live', label: 'Live', base: { symbol: 'BTC/USDT:USDT' }, tunable: { sizeUsd: 500, stopPct: 1.5 } },
]
```

`id` is what the form remembers; `label` is what it shows; `description` appears under the label.

## Don'ts

- Don't ask for a venue/exchange param — derive from the account (rule 5).
- Don't loop/sleep/schedule in `evaluate()` — it must return promptly; timing belongs to the
  executor (which may sleep) or a cron trigger.
- Don't hold state in class fields for correctness — instances restart; use `this.store`.
- Don't call `evaluate` logic on data you didn't verify came from your trigger — always check
  `context.getData(...)` for undefined.
