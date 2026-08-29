# Plugins, Venues, Accounts, Kinds, Packaging

## The manifest

The package's default export. Decorated classes go in arrays; adapter cells and credential types
stay plain JSON. All fields optional — the field set defines the plugin's identity.

```ts
import { z } from 'zod'
import { definePlugin } from '@openwhaleorg/core'
import type { RawCredentialData } from '@openwhaleorg/core'

export default definePlugin({
  name: 'my-plugin',            // becomes the id namespace for every component
  version: '1.0.0',
  readme: '# my-plugin\n…',      // markdown for the Plugins page detail pane (optional)
  logo: 'data:image/png;base64,…', // brand mark: https URL or data: URI; `icon: '🎯'` is the fallback

  credentialTypes: [ /* §Credential types */ ],
  adapters:        [ /* §Adapters */ ],
  accounts:        [ /* @OwAccount classes */ ],
  monitors:        [ /* @OwMonitor classes */ ],
  executors:       [ /* @OwExecutor classes */ ],
  strategies:      [ /* @OwStrategy classes */ ],
})
```

`definePlugin` covers everything above. Two things live only on the raw factory form (below):
`scripts` and the deprecated `publicSessions` — passing either to `definePlugin` is a type error.

Plugin archetypes:
- **Venue plugin** (binance, hyperliquid): credentialTypes + adapters (+ specialized Account).
- **On-chain venue plugin** (pendle): adapters whose cells accept the shared wallet family
  (`credentialTypes: ['web3/evm']`, from `@openwhaleorg/web3`) plus any venue-issued key of its own
  (a delegated agent key, usually `managed`) — no chain client of its own.
- **Domain package** (exchange): mock adapter cells + generic Account/Monitor/Executor classes.
- **Strategy package**: strategies + their private monitors/executors.
- **Pure data source**: credentialTypes + a specialized Monitor.

## Credential types

```ts
credentialTypes: [{
  type: 'my-venue',                       // convention: = plugin name
  displayName: 'My Venue',
  documentationUrl: 'https://docs.my-venue.example',
  schema: z.object({
    apiKey: z.string().meta({ displayName: 'API Key' }),
    apiSecret: z.string().meta({ displayName: 'API Secret', password: true }),
    testnet: z.boolean().default(false).meta({ displayName: 'Testnet' }),
  }),
  test: async (data) => { await buildAdapter(data).fetchBalance() },   // throws = form shows error
  // raw: true,   // ONLY if some executor needs the raw data (raw slots are gated on this)
  // logo: PNG_DATA_URI, icon: '🔑', description: 'One line under the name in the picker',
  // managed: true,   // created by a script/flow (e.g. a delegated agent key): hidden from the
  //                  // add-credential picker, existing entries still list and edit
}],
```

`type` names a key FAMILY, so it need not equal a venue: `'web3/evm'` is one wallet key that opens
every EVM venue; a CEX key is its own family (`'binance'`). Namespace types the plugin owns as
`'{plugin}/{name}'` when the plugin has more than one (`'pendle/boros-agent'`).

Anything that changes how the credential is INTERPRETED (testnet, unified-account flag) belongs in
the credential schema — never in plugin config.

## Adding a plain ccxt exchange — use the roster, not a new package

If the venue is on ccxt and needs no custom behaviour, do NOT write a plugin: add one entry to
`packages/venues/roster/src/venues.ts`. `defineCcxtVenue` lowers the description into exactly the manifest
below, and the gateway already loads the whole roster.

```ts
{
  name: 'bybit',                    // plugin name AND credential type
  displayName: 'Bybit',
  documentationUrl: 'https://bybit-exchange.github.io/docs/v5/intro',
  markets: { 'exchange/perp': 'bybit', 'exchange/spot': 'bybit' },   // kind → ccxt id
  credentialStyle: 'key-secret',    // | 'key-secret-passphrase' | 'private-key'
  testnet: true,                    // venue has a sandbox → form gets the toggle
  // extraFields / ccxtOptions for venue-specific identifiers (see lighter)
}
```

Rules the roster encodes: **one entry = one API key** (Kraken spot and Kraken Futures need
different keys behind different ccxt ids, so they are two venues); a venue serving both kinds off
one key gets two cells in one entry. The package's tests re-verify every ccxt id, market type and
required-credential list against the installed ccxt on each run.

Write a real venue package only when the venue needs code: a quirk override (Hyperliquid's market
orders need a price), a specialized Account (Binance portfolio-margin equity), or a venue-only
Monitor.

## Adapters — the (kind, venue) cells

```ts
const build = (data: RawCredentialData) => new MyVenueAdapter({
  apiKey: data['apiKey'] as string,
  apiSecret: data['apiSecret'] as string,
  testnet: (data['testnet'] as boolean | undefined) ?? false,
})

adapters: [{
  kind: 'exchange/perp', venue: 'my-venue',          // credentialTypes defaults to ['my-venue']
  // data optional: keyless call → public/read-only form (or throw if none exists)
  create: (data?) => data ? build(data) : new CcxtAdapter({ exchangeId: 'myvenue' }),
}],
```

A cell is `(kind, venue)`; `credentialTypes` lists the key families that open it. On-chain venues
share the wallet family instead of issuing keys:

```ts
adapters: [
  { kind: 'pendle/market', venue: 'pendle', credentialTypes: ['web3/evm'],
    create: (data) => new PendleMarketSession(data ? { privateKey: String(data['privateKey']) } : {}) },
  { kind: 'pendle/rates',  venue: 'boros',  credentialTypes: ['pendle/boros-agent'],   // venue-issued agent key
    create: (data) => new BorosSession(data ? toAgentOptions(data) : {}) },
]
```

`type:` is the deprecated spelling of `venue:` — existing cells load unchanged, write `venue` in new code.

For `'exchange/perp'` cells the returned object must implement `PerpExchangeAdapter` from
`@openwhaleorg/exchange` (fetchTicker/fetchBalance/fetchPositions/createOrder/setLeverage/
fetchFundingRates/watchTrades/...). If the venue is on ccxt, `CcxtAdapter` from
`@openwhaleorg/ccxt-adapter` already implements it — wrap or subclass instead of hand-rolling.

## Account implementations

An account implementation is a plain class: `constructor(accountName, session, params?)` where
session is the adapter for the bound credential and `params` the values of its `paramsSchema`. It is
the READ VIEW strategies receive — expose read methods only.

```ts
import { OwAccount } from '@openwhaleorg/core'
import type { PerpExchangeAdapter } from '@openwhaleorg/exchange'

@OwAccount({ id: 'my-venue-perp', kind: 'exchange/perp', venue: 'my-venue',   // omit venue = kind-generic
             displayName: 'My Venue Perp Account' })
export class MyVenuePerpAccount {
  constructor(readonly accountName: string, protected readonly session: PerpExchangeAdapter) {}
  async balance() { return this.session.fetchBalance() }
  async positions() { return this.session.fetchPositions() }
  // Duck-typed Dashboard conventions (all optional):
  async snapshot(): Promise<{ equity: number; available?: number; unrealizedPnl?: number }> { ... }
  //   → drives the equity curve on the Accounts page
  // balance()/positions()/orders() → the account detail panels
}
```

The generic `PerpAccount` / `SpotAccount` from `@openwhaleorg/exchange` already cover any ccxt
venue — only specialize when the venue needs different math (e.g. Binance portfolio-margin equity).
Strategies reference the CLASS in their `accounts` declaration to get its typed surface.

### Account params and a declarative detail panel

One credential can back many accounts that differ by configuration (which chains a wallet
aggregates, which sub-account a venue key addresses). Declare that configuration as `paramsSchema`;
the Dashboard renders it on the account form and hands the validated values to the constructor.
When the generic balance/positions/orders panels don't fit the domain, declare the panel instead of
writing UI — `sections` maps the class's own reader methods to tables and key-value blocks:

```ts
const paramsSchema = z.object({
  chains: z.string().default('42161').meta({ displayName: 'Chain ids', placeholder: '1,42161,8453' }),
})

@OwAccount({
  id: 'boros-account', kind: 'pendle/rates', venue: 'boros', displayName: 'Boros Account',
  paramsSchema,
  sections: [
    { method: 'positions', title: 'Positions', kind: 'table', count: true, default: true, empty: 'No open positions.',
      columns: [
        { key: 'symbol', label: 'Market', format: 'mono', grow: true },
        { key: 'side', label: 'Side', format: 'side' },
        { key: 'sizeYu', label: 'Size (YU)', format: 'number', digits: 2, align: 'right' },
        { key: 'unrealisedPnl', label: 'Unrealised', format: 'signed', digits: 2, align: 'right' },
      ] },
    { method: 'summary', title: 'Summary', kind: 'keyvalue' },   // method returns Record<string, unknown>
  ],
})
export class BorosRatesAccount {
  constructor(readonly accountName: string, private readonly session: BorosSession, params?: Record<string, unknown>) { … }
  async positions(): Promise<Array<Record<string, unknown>>> { … }   // rows; keys match `columns[].key`
  async summary(): Promise<Record<string, unknown>> { … }
}
```

Column `format`s: `text | mono | number | usd | pct | signed | side | time | badge` (+ `digits`,
`align`, `grow`). A `table` section's method returns an array of rows; a `keyvalue` section's returns
one object. `count` shows the row count in the section header, `default` opens that section first,
`empty` is the text for no rows. Without `sections` the Dashboard falls back to the duck-typed
`balance()/positions()/orders()` panels.

## Extending the vocabulary: a new kind

A kind exists iff something claims it — there is no registration call. To introduce
`'lending/pool'`:

```ts
// 1. Type-level contract (declaration merging against core):
declare module '@openwhaleorg/core' {
  interface AdapterKindMap {
    'lending/pool': LendingPoolAdapter    // your interface for the cell contract
  }
}

// 2. A mock cell — canned data + no-op writes, powers AI-compiler dry-runs:
adapters: [{ kind: 'lending/pool', venue: 'mock', create: () => new MockLendingAdapter() }],

// 3. A kind-generic Account implementation (the canonical read view):
@OwAccount({ kind: 'lending/pool', displayName: 'Lending Pool Account' })
export class LendingPoolAccount { ... }
```

Kind names are namespaced `'domain/subkind'` — validated at load. After this, any plugin can add
`(kind='lending/pool', venue='aave')` cells and any strategy can declare slots of that kind.

The vocabulary, so packages agree: a **kind** is `'domain/product'` (`'exchange/perp'`,
`'pendle/rates'`); a **venue** is where it happens (`'binance'`, `'boros'`, `'evm'`); a **credential
type** is a key family (`'binance'`, `'web3/evm'`, `'pendle/boros-agent'`); a **cell** is
`(kind, venue)` plus the credential types that open it. Products that are their own category
(Pendle, Boros) get their own kinds under the plugin's namespace rather than being forced into
`exchange/*`.

## Scripts (operator utilities) — and the raw factory form

A script is trusted plugin code run on click from the Dashboard's Scripts page: plan previews, fit
inspectors, post-mortem reports. Deliberately NOT an instance — no lifecycle, no persistence, no
triggers. Anything that must run on a schedule is a monitor or a strategy instead.

```ts
export const planPreviewScript: ScriptDefinition = {
  id: 'plan-preview',                                   // qualified to '{plugin}/plan-preview'
  name: 'Plan Preview',
  description: 'Dry-run the next settlement plan without placing anything',
  paramsSchema: z.object({ instanceId: z.string().meta({ displayName: 'Instance' }) }),
  // Live dropdown choices, re-resolved on every listing — the param stays a plain string.
  paramOptions: async (runtime) => ({
    instanceId: (await (runtime as Rt).listInstanceViews()).map(v => ({ value: v.id, label: v.name })),
  }),
  run: async ({ params, runtime, emit, signal }) => {
    emit?.('scanning 40 markets…')        // streamed to the page while the run lasts (absent when not streaming)
    if (signal?.aborted) return { text: 'stopped' }   // the operator pressed Stop — check between slow steps, return what you have
    return { text: report, json: rows,   // text = monospace report, json = collapsible
             files: [{ name: 'report.csv', mime: 'text/csv', content: csv }] }   // downloads; inline, report-sized
  },
}
```

`signal` is the page's Stop button. It only helps if the script looks at it: check between slow
steps (each market of a scan, each page of a fetch) and return the partial result with a line
saying it was cut short — a script that ignores it runs to completion after the operator has
walked away.

### An HTML report

A `files` entry with `mime: 'text/html'` is rendered inline on the Scripts page, in a sandboxed
iframe, next to the text. Build it with core's shell so every plugin's report is the same page:

```ts
import { reportPage, esc, num, signed, cls } from '@openwhaleorg/core'

const html = reportPage({
  title: 'Boros maker incentives — BTC',      // browser tab / file name
  eyebrow: 'Boros · maker incentives',        // product line
  h1: 'Where the capital earns most',
  lede: `${plans.length} markets carry a live budget.`,
  ident: [`capital $${num(capitalUsd)}`, new Date().toISOString().slice(0, 16) + ' UTC'],
  figures: [                                  // above the fold; cls: 'pos' | 'neg' | 'warn' | 'dim'
    { k: 'Best market', v: best.symbol },
    { k: 'Per day', v: `$${num(best.usdPerDay, 2)}`, n: `${num(best.pendlePerDay, 2)} PENDLE`, cls: 'pos' },
  ],
  body: `<section><h2>Ranked</h2><div class="tblwrap"><table>
    <thead><tr><th>Market</th><th class="n">$ / day</th></tr></thead>
    <tbody>${plans.map(p => `<tr><td>${esc(p.symbol)}</td><td class="n ${cls(p.usdPerDay)}">${signed(p.usdPerDay)}</td></tr>`).join('')}</tbody>
  </table></div></section>`,                  // the caller escapes its own content — esc() everything from data
  footer: 'Where the numbers came from, and what they assume.',
})
return { text, files: [{ name: 'scan.html', mime: 'text/html', content: html }] }
```

Self-contained by design — no external CSS, fonts or scripts, so the file opens from disk the same
as in the page. Links to the outside need `target="_blank"` (the sandbox blocks in-frame navigation).
`.n` right-aligns a numeric cell; `.dim` mutes; `.tblwrap` scrolls a wide table instead of the page.

### The raw factory form

`definePlugin` accepts `scripts` directly. The raw `PluginFactory` form exists for one other reason —
access to the plugin `context` at construction — and costs the decorator-derived definitions:

```ts
export const myPlugin: PluginFactory<MyConfig> = (context): OpenWhalePlugin => ({
  name: 'my-plugin',
  version: '1.0.0',
  credentialTypes: [ ... ],
  scripts: [planPreviewScript],
  // Raw form takes LOWERED entries, not classes: strategies are
  // `{ definition, factory }`, executors `{ definition, instance }`,
  // monitors go under `monitorImplementations` (the plain `monitors` field is legacy).
  strategies: [{ definition: { id: 'my-strategy', /* … */ }, factory: () => new MyStrategy() }],
})
export default myPlugin
```

That is the whole trade-off: the raw form costs you the decorator-derived definitions (you hand-write
each `definition`, including `accountRequirements`), and buys access to `context`. Prefer `definePlugin`
until you actually need it.

## Packaging

```jsonc
// package.json
{
  "name": "@you/openwhale-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",                  // entry MUST default-export the definePlugin result
  "types": "dist/index.d.ts",
  "files": ["dist"],
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run" },
  "peerDependencies": { "@openwhaleorg/core": "^0.2.2" },   // a REAL range — see below
  "dependencies": { "zod": "^4.0.0" }       // + @openwhaleorg/exchange etc. as needed
}
```

The peer range is a contract the engine enforces at install. It is checked against the running
engine's own core before anything is staged; a mismatch is refused with both versions and which
side to move. So:

- **Declare the version you actually built against**, caret (`^0.2.2`). In 0.x the minor is the
  major, so `^0.2.2` means ≥ 0.2.2 < 0.3 — exactly the engines your imports exist on.
- **Never `*`.** It is satisfied by an engine that lacks the exports you import, and the failure
  then surfaces at load as `does not provide an export named 'x'` — an error that names your plugin
  and says nothing about the engine being behind.
- The engine's framework copy is the only one. Whatever npm fetches for `@openwhaleorg/*` is
  replaced by a link to the engine's own; a plugin never runs its own core. Framework packages go
  in `peerDependencies`, not `dependencies`.

```jsonc
// tsconfig.json — ES2022+, NodeNext, NO experimentalDecorators
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "declaration": true, "outDir": "dist", "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"], "exclude": ["src/**/__tests__"]
}
```

```ts
// vitest.config.ts — es2022 or decorated classes fail to parse
import { defineConfig } from 'vitest/config'
export default defineConfig({ esbuild: { target: 'es2022' } })
```

`src/index.ts` re-exports the plugin as default:

```ts
export { default } from './plugin.js'
export * from './plugin.js'
```

## Install & iterate

- Dashboard → Plugins → Install: an npm spec, a GitHub `owner/repo` (optional `#ref`; source-only
  repos need a `prepare` script, private ones `OPENWHALE_GITHUB_TOKEN`), or the package's
  **absolute local path**. Every install loads from its own staged copy, so `pnpm build` then
  install again over the same name picks up changes without a restart — an install over an
  installed plugin is an overwrite that keeps instances, accounts and credentials.
- API: `POST /api/plugins {"source":"npm","package":"/abs/path"}` or
  `{"source":"github","repo":"owner/repo","ref":"main"}`; `DELETE /api/plugins/{name}` to uninstall —
  refused while an instance, account or credential references the plugin.
- A name another plugin already holds gets a namespace at install (`alice-funding-arb`); adapter
  cells and credential types are global, so two plugins providing the same venue cannot coexist.
  The README's §Plugins is the full rule list.
- Entry resolution reads `exports`/`module`/`main` from your package.json.
- Refusals come with their reason: `cannot run on this engine` is the peer range (§Packaging);
  load-time failures (bad keySchema narrowing, unknown kind, duplicate ids) name the exact rule.
