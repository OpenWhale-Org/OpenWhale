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

## Lifecycle hooks

Two optional overrides, both traced like a run (`lifecycle:<reason>` on the instance board):

```ts
override async onActivate(ctx: LifecycleContext): Promise<ExecutionInstruction[] | void> {
  // After every setter, triggers registered, nothing fired yet.
  if (!(await this.store.has('baseline'))) await this.store.set('baseline', await this.snapshot())
  this.trace('leverage', { leverage: 3 })
  return [this.instruction('trade', 'setLeverage', { symbol, leverage: 3 }, ['main'])]   // fired inline, awaited
}

override async onDeactivate(ctx: LifecycleContext): Promise<ExecutionInstruction[] | void> {
  // No run in flight, no new one can start, executor slots still materialized.
  const quote = await this.store.get<RestingQuote>('quote')
  if (!quote || ctx.reason === 'restart') return          // keep it across a restart if you like
  return [this.instruction('trade', 'cancelOrder', { orderId: quote.orderId, symbol: quote.symbol }, ['main'])]
}
```

| `ctx.reason` | when |
|---|---|
| `activate` | operator activates a stopped instance |
| `boot` | the runtime restores persisted active instances at start |
| `restart` | `updateInstance(…, { restart: true })` — deactivate, then activate the new object |
| `rollback` | the restart's activation failed; the previous configuration is reactivated |
| `stop` / `delete` | operator deactivates / deletes |
| `shutdown` | `runtime.stop()` — one quiesce budget across every instance |

Rules the runtime enforces: returned instructions pass through label resolution and the dry-run
gate exactly as a run's do, and are **fired inline and awaited** — leverage is set before the
first clip, a quote is cancelled by the slots that are about to be removed. `onActivate` throwing
fails the activation and un-registers what was registered. `onDeactivate` throwing, or running
past `quiesceTimeoutMs` (runtime option, default 15 s), is logged and teardown continues: an
instance that cannot be stopped would resume trading on the next boot. Do housekeeping here, not
on the first evaluation behind a store flag — that spends the first trigger.

## Text in more than one language

Every string a person reads — the strategy's `name` and `description`, a param's `displayName`,
`description`, `hint`, `placeholder` and `section`, an enum option's `label`, a list column's name,
an illustration's `title`, a preset's or picker's `title`/`description`, a Script's name and params,
the plugin's `readme` — is a `Text`: a plain string (English) or a table with `en` required:

```ts
// In a zod .meta(): English as written, translations under i18n — zod types
// `description` as a string, so a table cannot sit there directly.
notionalUsd: z.number().positive().meta({
  displayName: 'Notional (USD)', description: 'Per leg. Every leg is this size.',
  i18n: { 'zh-CN': { displayName: '名义仓位（USD）', description: '每条腿的名义金额，四条腿相同。' } },
}),
// Everywhere else — decorators, manifests, cards, account panels — a table:
@OwStrategy({ name: { en: 'Fixed-rate carry', 'zh-CN': '固定利率套利' }, description: { en: '…', 'zh-CN': '…' } })
```

The gateway resolves every table for the reader's locale before a page sees it; a locale that
is missing falls back to `en`. **Our own strategies carry `en` and `zh-CN` on every string.**
Dynamic text — preset and picker cards, illustration figures, a Script's report — is yours to
write in `ctx.locale` (`PresetContext.locale`, `ScriptContext.locale`; the illustration message
carries `locale` too); core exports `resolveText(text, locale)` for the tables you keep yourself.

A plugin that keeps its source in one language ships language packs instead, and an operator
can lay their own over any plugin from `<dataDir>/i18n/<plugin>/<locale>.json`:

```ts
definePlugin({
  i18n: { 'zh-CN': { 'strategies.fixed-rate-carry.name': '固定利率套利', 'strategies.fixed-rate-carry.params.legs.displayName': '四条腿', 'readme': '…' } },
})
```

Paths: `strategies|monitors|executors|scripts|accounts.<local id>.<field>`, with
`params.<name>.<field>` and `params.<name>.options.<value>.label` underneath, and `readme`.
Never translate trace step names, log lines or ids — those are keys people grep for.

## Quick and pinned parameters

A strategy with forty knobs has five an operator touches every day. Name them on the field meta:

```ts
maxLegUsd: z.number().positive().meta({ displayName: 'Notional (USD)', pinned: true }),   // pinned ⇒ quick
entryPct:  z.number().default(1).meta({ displayName: 'Entry %', quick: true }),
```

- `quick` puts the field on the **quick parameters** panel at the top of the instance board; the full
  form folds beneath it. Pick what is tuned most — position size, the entry ladder, a stop.
- `pinned` (three at most per strategy) makes the field editable **straight from the instance
  list**, no board needed. The most important sizing knobs, not the most numerous.
- These are the strategy's defaults. An operator may keep their own sets per instance
  (`quickParams` / `pinnedParams` on the instance); the board's "Configure…" dialog writes them.
- A list-typed field can be quick, not pinned — a row has no room for a ladder.

## Presets — named configurations, or a live ranking

`paramPresets` is a static list: "conservative", "aggressive", "paper". Each names the fields
it sets; the Dashboard renders a dropdown and fills those fields, leaving every field editable.

A strategy whose sensible starting points are **opportunities** — which pair, which market,
right now — computes them instead (core ≥ 0.2.3):

```ts
override readonly presetSource = { title: 'Fixed-rate opportunities', description: 'Ranked by net APR after fees at $100k per leg; executable pairs first.', ttlMs: 60_000 }

override async presets(ctx: PresetContext): Promise<ParamPreset[]> {
  const boros = await ctx.adapters.resolve<BorosSession>('pendle/rates', 'boros')     // keyless cells only
  const markets = await boros.fetchMarkets()
  return rank(markets).map(o => ({
    id: `${o.longMarket}|${o.shortMarket}`,
    label: `${o.asset} ${o.longVenue} ↔ ${o.shortVenue}`,
    base: { longMarket: o.longMarket, shortMarket: o.shortMarket, perpLongSymbol: o.perpLong, perpShortSymbol: o.perpShort },
    card: {
      title: o.asset, subtitle: `${o.longVenue} ↔ ${o.shortVenue}`,
      headline: { label: 'net APR', value: pct(o.netApr), tone: o.netApr >= 0 ? 'positive' : 'negative' },
      rows: [{ label: 'matures', value: `${o.days}d` }, { label: 'per leg', value: '$100k' }],
      badges: o.executable ? [{ text: 'executable', tone: 'positive' }] : [],
      group: o.executable ? 'Executable' : 'Not on this venue',
    },
  }))
}
```

Rules:
- `presets()` runs on a **probe** instance: no store, no accounts, no params of its own. It gets
  keyless adapters, the slots the operator has bound so far (`ctx.accounts`, label → account
  name) and the form's current values (`ctx.params`), which a scan may size to.
- The runtime caches the result for `presetSource.ttlMs` (default 60 s) keyed by those inputs;
  the dialog's Refresh bypasses it. Throw on a venue you cannot reach — an empty list reads as
  "no opportunities", which is a different fact.
- The **order is the ranking**. Cards with the same `group` sit under one heading, groups in
  first-seen order. Static `paramPresets` are listed first, as a plain list.
- A preset with a `card` renders as one: `title` / `subtitle` top left, the `headline` figure set
  large top right, `rows` as label/value pairs, `badges` as pills. Tones are `positive |
  negative | neutral | muted` — theme colours, so the card is right in both themes. `card.html`
  replaces all of that with your own drawing in a sandboxed frame, as a `ParamIllustration` is.
- The moment any preset carries a card, or the strategy has a `presetSource`, the Dashboard
  offers a dialog instead of the dropdown. Choosing fills the named fields; nothing is locked.
- The same scan usually wants to exist as a **Script** too (a report an operator runs without
  opening the form). Put the computation in one module and call it from both.

## Picker fields — a value that is a whole decision

A catalogue answers "which symbol". When the choice is several things at once — the four legs
of a carry, a market with its size — make the param an **object** and give it a picker (core ≥
0.2.3):

```ts
legs: z.object({ longMarket: z.string(), shortMarket: z.string(), perpLongSymbol: z.string(), perpShortSymbol: z.string() }).meta({
  displayName: 'The four legs',
  picker: { source: 'strategy', id: 'carry-legs', title: 'Fixed-rate carry opportunities', description: 'Ranked by net APR after fees.', ttlMs: 60_000 },
})

override async pickerOptions(pickerId: string, ctx: PresetContext): Promise<PickerOption[]> {
  if (pickerId !== 'carry-legs') return []
  return (await scan(ctx.adapters)).map(o => ({
    id: o.id, label: `${o.asset} ${o.longVenue} → ${o.shortVenue}`,
    value: { longMarket: o.longMarket, shortMarket: o.shortMarket, perpLongSymbol: o.perpLong, perpShortSymbol: o.perpShort },
    card: { title: o.asset, headline: { label: 'net APR', value: pct(o.netApr), tone: 'positive' }, rows: [...], badges: [...], group: 'Executable' },
  }))
}
```

The Dashboard draws the field as a button naming the current choice and opens the same card
dialog presets use; choosing sets the field to `option.value`. `pickerOptions()` runs on a probe
with keyless adapters, the bound slots and the form's current values, cached for `ttlMs`; the
order is the ranking. Prefer this over a preset when the decision IS the param — a preset fills
fields the operator may then drift from, a picker keeps the four names together.

## Illustrations with live figures

`paramsIllustrations` are HTML pages drawn in the form — above the fields by default, after a
named `section`, with `placement: 'after-base'` between the base and tunable params, or `'bottom'` after the last
field (a preview of what the fields add up to belongs below them). Each receives `{ type: 'ow-params',
values }` by postMessage on load and on every edit. A page that needs what the form does not
hold — quotes, an estimate, the venue's limits — gets it from the strategy (core ≥ 0.2.3):

```ts
readonly paramsIllustrations = [carryIllustration]

override async illustrationData(ctx: PresetContext): Promise<Record<string, unknown>> {
  const b = ctx.params.base
  if (!b['longMarket']) return { ok: false, reason: 'Pick a market to see the estimate.' }
  const boros = await ctx.adapters.resolve<BorosSession>('pendle/rates', 'boros')
  const q = await boros.marketQuote(await marketId(boros, String(b['longMarket'])))
  return { ok: true, estimate: carryEstimate({ ...termsOf(q), notionalUsd: Number(b['notionalUsd']) }) }
}
```

The Dashboard calls it, debounced, whenever the form changes, and posts the answer to every frame
as `data` (a throw arrives as `dataError`; `pending: true` while a newer answer is on its way, so
the page can dim what it shows). A page that posts `{ type: 'ow-size', height }` to its parent
gets that height — do it after every render, so nothing is clipped at any panel width. The
message also carries `logos`: credential type → logo URL (`gate`, `hyperliquid`,
`pendle/boros-agent`, …), the marks the Accounts page draws, for a picture that names venues. Same probe rules as `presets()`: keyless adapters, no
store; the runtime caches by form state for 15 s. Keep the arithmetic here and let the page only
format — one estimator, the strategy's own, for the trace, the presets and the picture.

## Dry run is the framework's, not yours

Do not declare a `dryRun` param. Every instance has a **Dry run** option (`options.dryRun`), and
under it the engine records what a run returns without sending it — the trace and the Executions
page show the instruction, no result comes back, `onExecutionResult` is not called. Emit the real
actions (`clip`, `open`, `cancel`); a `simulate*` twin the strategy chooses itself still reaches
the venue and gives an operator two switches to read where one would do. `ctx.dryRun` is there
for the rare strategy whose own memory depends on whether an order went out (a maker that
remembers the quote it would have rested); read it, never branch the action on it.

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
| `onActivate(ctx)` / `onDeactivate(ctx)` | Lifecycle hooks — see the section above |
| `presetSource` / `presets(ctx)` | Live presets — see the section above |
| `illustrationData(ctx)` | Live figures for the illustrations — see the section above |
| `pickerOptions(id, ctx)` | Options of a picker field — see the section above |
| `onExecutionResult(result, { instanceId })` | Optional override: called with the executor's recorded `ExecutionResult` for every instruction THIS instance emitted (success, failed or skipped), after the record is written — the place to note fill ids or a failed leg in `this.store`. `this.store` is the same per-instance store; `this.trace` is a no-op here unless a run happens to be active. Runs off the queue path: a throw is logged as a warning and never touches the execution record |
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

**Two venues in one form.** By default the picker and any `availability` check use the venue of the
FIRST bound account slot. A strategy binding two accounts on different venues (a cross-venue pair)
names the slot each symbol belongs to with `accountSlot` — the slot's `label` from `accounts` — on
the catalogue and the availability marker. An unbound or unknown slot falls back to the first one:

```ts
override readonly accounts = [
  { label: 'long', kind: 'exchange/perp' },
  { label: 'short', kind: 'exchange/perp' },
]
override readonly baseParamsSchema = z.object({
  longSymbol: z.string().meta({
    displayName: 'Long symbol',
    catalogue: { source: 'market', kind: 'exchange/perp', marketType: 'swap', accountSlot: 'long' },
    availability: { source: 'market', accountSlot: 'long' },
  }),
  shortSymbol: z.string().meta({
    displayName: 'Short symbol',
    catalogue: { source: 'market', kind: 'exchange/perp', marketType: 'swap', accountSlot: 'short' },
    availability: { checker: 'liquidity', accountSlot: 'short' },
  }),
})
```

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
