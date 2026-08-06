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
}],
```

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

## Adapters — the (kind, type) cells

```ts
const build = (data: RawCredentialData) => new MyVenueAdapter({
  apiKey: data['apiKey'] as string,
  apiSecret: data['apiSecret'] as string,
  testnet: (data['testnet'] as boolean | undefined) ?? false,
})

adapters: [{
  kind: 'exchange/perp', type: 'my-venue',
  // data optional: keyless call → public/read-only form (or throw if none exists)
  create: (data?) => data ? build(data) : new CcxtAdapter({ exchangeId: 'myvenue' }),
}],
```

For `'exchange/perp'` cells the returned object must implement `PerpExchangeAdapter` from
`@openwhaleorg/exchange` (fetchTicker/fetchBalance/fetchPositions/createOrder/setLeverage/
fetchFundingRates/watchTrades/...). If the venue is on ccxt, `CcxtAdapter` from
`@openwhaleorg/ccxt-adapter` already implements it — wrap or subclass instead of hand-rolling.

## Account implementations

An account implementation is a plain class: `constructor(accountName, session)` where session is
the adapter for the bound credential. It is the READ VIEW strategies receive — expose read
methods only.

```ts
import { OwAccount } from '@openwhaleorg/core'
import type { PerpExchangeAdapter } from '@openwhaleorg/exchange'

@OwAccount({ id: 'my-venue-perp', kind: 'exchange/perp', type: 'my-venue',   // omit type = kind-generic
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
adapters: [{ kind: 'lending/pool', type: 'mock', create: () => new MockLendingAdapter() }],

// 3. A kind-generic Account implementation (the canonical read view):
@OwAccount({ kind: 'lending/pool', displayName: 'Lending Pool Account' })
export class LendingPoolAccount { ... }
```

Kind names are namespaced `'domain/subkind'` — validated at load. After this, any plugin can add
`(kind='lending/pool', type='aave')` cells and any strategy can declare slots of that kind.

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
  run: async ({ params, runtime }) => ({ text: report, json: rows }),   // text = monospace report
}
```

`scripts` is not a `definePlugin` field. A plugin that ships them exports a `PluginFactory` — a
function of the plugin context returning the manifest shape directly:

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
each `definition`, including `accountRequirements`), and buys `scripts` plus access to `context`.
Prefer `definePlugin` until you actually need one of those.

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
  "peerDependencies": { "@openwhaleorg/core": "*" },
  "dependencies": { "zod": "^4.0.0" }       // + @openwhaleorg/exchange etc. as needed
}
```

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

- Dashboard → Plugins → Install: enter the package's **absolute local path** or an npm spec.
  Local installs are npm-symlinked: `pnpm build` in your package, then uninstall+reinstall (or
  restart the gateway) to pick up changes.
- API: `POST /api/plugins {"source":"npm","package":"/abs/path"}`;
  `DELETE /api/plugins/{name}` to uninstall.
- Entry resolution reads `exports`/`module`/`main` from your package.json.
- Load-time failures (bad keySchema narrowing, unknown kind, duplicate ids) surface in the
  install response — read the error text, it names the exact rule violated.
