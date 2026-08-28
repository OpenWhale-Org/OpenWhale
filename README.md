# OpenWhale

<img src="./logo.svg" width="64" height="64" />

**The programmable layer for composable, AI-native economic strategies**

![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

[中文说明 →](./README.zh-CN.md)

OpenWhale is a TypeScript framework for automated trading strategies. Monitors collect, Strategies decide, Executors act; the three are decoupled, so one strategy runs on any venue and against any data source, and can be written, audited and evolved by an AI.

---

## Quick start

Development mode, with hot reload. For a server see [DEPLOYMENT.md](./DEPLOYMENT.md) (`docker compose up -d --build`, or systemd + nginx).

Prerequisites: Node.js ≥ 20, pnpm ≥ 9.

```bash
pnpm install
pnpm build
cp .env.example .env           # OPENWHALE_MASTER_KEY, OPENWHALE_ADMIN_USER, OPENWHALE_ADMIN_PASSWORD
pnpm dev                       # gateway :3001, dashboard :3000
```

The gateway holds the runtime and all secrets; the dashboard is a frontend that proxies `/api/*` to it (`OPENWHALE_GATEWAY_URL`, default `http://localhost:3001`). The gateway refuses to start without a user account or the admin variables; set them once, sign in, then remove them.

### Venue proxy

```bash
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897        # REST + WebSocket, every venue
OPENWHALE_HTTPS_PROXY_BINANCEUSDM=off              # per venue: ccxt id upper-cased; `off` = direct
```

`HTTPS_PROXY` and `NODE_USE_ENV_PROXY` are not honoured — ccxt uses its own fetch. The variable is namespaced so that order traffic never changes route through an unrelated proxy setting.

### Authentication

Enforced by the gateway: every `/api/*` route requires a session; the dashboard only carries the cookie. Sessions are opaque SQLite tokens (7-day expiry, revocable); passwords are scrypt-hashed; there are no roles. Before exposing the gateway: terminate TLS in front of it (the session cookie is `Secure`), keep port 3001 off the public internet, set `OPENWHALE_ALLOWED_ORIGIN` only for cross-origin frontends. Details in [DEPLOYMENT.md](./DEPLOYMENT.md).

---

## Why OpenWhale

- **Decoupled layers** — Monitor → Strategy → Executor. Replace any layer without touching the others.
- **Venue-agnostic** — strategies declare account slots; the venue is resolved from the bound account at activation.
- **Adapter matrix** — venues are cells of a *(kind × venue)* matrix (`exchange/perp × binance`, …). Domain packages define kinds, venue packages fill cells; a data-driven ccxt roster ships twelve venues.
- **AI as a programmer** — structured-output LLM inference inside strategies, and a `skills/openwhale-dev` skill that teaches Claude the framework contract.
- **Run tracing** — every run persists what it saw, which gate refused, what it emitted. Survives restarts.
- **PnL attribution** — executors claim the orders they place; fills, fees and funding are joined back to the instance. Two instances on one account stay separable.
- **Type-safe plugins** — every component implements a strict TypeScript interface.

---

## Core concepts

| Concept | Definition |
|---|---|
| **Monitor** | Collects data and emits keyed records (`venue:symbol`). A *contract* with one or more *implementations*; users create per-key *instances*. Emits persist as JSONL and drive triggers. |
| **Strategy** | Pure decision logic. Declares monitor / executor / account dependencies by label, receives triggers, returns `ExecutionInstruction[]`. Params: `base` (required) and `tunable` (defaulted) zod schemas. |
| **Executor** | Turns instructions into venue actions through adapter sessions — retries, idempotent client order ids, latency and slippage capture. Credential slots resolve to sessions (by kind) or raw credential data (`raw: true`); `optional: true` slots may stay unbound. |
| **Instance** | Strategy + params + account bindings, activated as a unit. Live events, executions, runs and logs hang off it. |
| **Account** | A named binding of a credential to an account implementation (generic or venue-specialized). Strategies read balances and positions through it. |
| **Trigger** | Cron schedules and monitor conditions (multi-source AND within a window). Subscriptions keep monitors collecting without waking the strategy; `addMonitorSource` adds sources discovered at runtime. |
| **Portfolio journal** | Optional instance-scoped history: idempotent snapshots, fills, decisions, market bars. Core stores them and derives equity, drawdown and trade reports. |

```
Monitor ──emit(key, data)──▶ TriggerManager ──StrategyContext──▶ Strategy ──ExecutionInstruction[]──▶ ExecutionQueue ──▶ Executor
                                                                     └─ run trace persisted
```

---

## Dashboard

| Page | Function |
|---|---|
| **Instances** | Cards with folders, drag ordering, live net-PnL badge; per-instance Live Events, Executions, Runs, Logs; Board view with parameter editing, account rebinding, PnL panel. |
| **PnL** | Realized / fees / funding / net / unrealized from the attribution ledger; by-symbol, raw fills, open positions at venue mark. Funding is split across instances by position at settlement. |
| **Runs** | Every run's gates, skips, sizing, instructions and log lines. Runs with instructions or errors persist; idle runs are sampled. |
| **Monitor boards** | Panels declared by `plots()`: line, bar, candles, sortable table; single/multi-select keys. |
| **Params** | Forms generated from zod `.meta()`: sections, sliders, units, conditional fields, market pickers, availability checks, list (row-table) params, live interactive illustrations. |
| **Scripts** | Plugin-shipped operator utilities run on demand against the runtime; monospace report, optional JSON and file attachments. |
| **Compiler / Assistant** | Natural-language strategy compiler (experimental). Recommended path: Claude with `skills/openwhale-dev`. |

---

## Code examples

### A minimal strategy

```typescript
const decls = {
  monitors: [{ name: 'exchange/ticker', label: 'price' }],
  executors: [{ name: 'exchange/perp-trading', label: 'perp' }],
  accounts: [{ account: PerpAccount, label: 'main' }],
} as const satisfies StrategyDeclarations

class MomentumStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'momentum'
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  readonly baseParamsSchema = z.object({
    symbol: z.string().meta({ displayName: 'Symbol' }),
    threshold: z.number().meta({ displayName: 'Entry price' }),
  })

  async evaluate(context: StrategyContext) {
    const { symbol, threshold } = this.baseParamsSchema.parse(this.params.base)
    const tick = context.getData('price', `${this.accountVenue('main')}:${symbol}`)
    this.trace('tick:read', { tick })                    // recorded in the run trace
    if (!tick || tick.price < threshold) return []

    return [
      this.instruction('perp', 'placeOrder', {
        symbol, side: 'buy', type: 'market', amount: 0.01,
      }),
    ]
  }
}
```

### Assembling the runtime

```typescript
const runtime = new OpenWhaleRuntime({ database, credentialStore })
runtime.loadPlugin(binancePlugin, {})
runtime.loadPlugin(hyperliquidPlugin, {})
await runtime.start()
await runtime.activate({
  strategyId: 'my-plugin/momentum',
  credentials: { main: 'My Binance' },       // the account binding decides the venue
  params: { base: { symbol: 'BTC/USDT:USDT', threshold: 60000 } },
})
```

### AI-driven strategy with structured output

```typescript
async evaluate(context: StrategyContext) {
  const data = await this.monitorData('market')?.readLatest(this.accountVenue('main'))

  const { action, confidence } = await this.llm({
    messages: [{ role: 'user', content: JSON.stringify(data) }],
    schema: z.object({
      action: z.enum(['buy', 'sell', 'hold']),
      confidence: z.number(),
    }),
  })
  if (action === 'hold' || confidence < 0.7) return []

  return [
    this.instruction('perp', 'placeOrder', {
      symbol: 'BTC/USDC:USDC', side: action, type: 'market', amount: 0.01,
    }),
  ]
}
```

### An operator script

```typescript
export const planPreview: ScriptDefinition = {
  id: 'plan-preview',
  name: 'Plan preview',
  paramsSchema: z.object({ instance: z.string().default('') }),
  paramOptions: async (runtime) => ({ instance: await listMyInstances(runtime) }),
  run: async ({ params, runtime }) => ({ text: await renderPlan(runtime, params) }),
}
```

---

## Plugins

A plugin is a package whose default export is a factory returning its registrations:

```typescript
export default definePlugin((ctx) => ({
  name: 'my-plugin',
  version: '1.0.0',
  monitorImplementations: [ /* contract / implementation / instance */ ],
  executors: [ /* … */ ],
  strategies: [ /* … */ ],
  scripts: [ /* operator utilities */ ],
  credentialTypes: [ /* schema, raw opt-in, connectivity test */ ],
  adapters: [ /* (kind × venue) cells */ ],
  accounts: [ /* account implementations */ ],
}))
```

**Install** from the Plugins page — npm name, GitHub `owner/repo` (optional ref), local path, or a built `.js`/`.mjs` bundle — or `runtime.loadPlugin()` in code. A GitHub install is built by npm, so a source-only repo needs a `prepare` script; private repos need `OPENWHALE_GITHUB_TOKEN`.

**Rules:**

- The plugin name is its namespace (`my-plugin/momentum`). A taken name gets a new namespace at install (`alice-funding-arb`); a namespace is fixed once instances reference it.
- Adapter cells and credential types are global: two plugins providing the same venue cannot coexist. Registration is all-or-nothing.
- Overwrite keeps instances, accounts and credentials; instances whose strategy the new version dropped are marked broken, not deleted.
- npm installs show a newer registry version in the rail and update in one click (same overwrite path).
- Uninstall is refused while an instance, account or credential references the plugin; the plugin's monitor instances are deleted with it.
- Each install loads from its own copy under `plugins/staged/`, so reinstalling needs no restart.

### Writing plugins with Claude

Copy `skills/openwhale-dev/` into your plugin project's `.claude/skills/` (or reference this repo's path), describe the strategy, and Claude produces a complete plugin package — monitors, executors, strategies, tests — installable from the Plugins page.

---

## Use cases

| Category | Shape |
|---|---|
| **Funding / basis arbitrage** | Perp vs spot or perp vs perp, timed around settlement, hedged |
| **Cross-venue arbitrage** | The same instrument on two venues, two accounts, one strategy |
| **Market making** | Two-sided quotes managed against inventory and volatility; includes incentive-band quoting on DEXs |
| **Statistical arbitrage / pairs** | Spread or z-score monitors driving hedged multi-leg positions |
| **Trend following / mean reversion** | Indicator-driven directional strategies on any market |
| **Grid / DCA** | Scheduled or level-triggered accumulation and distribution |
| **Copy trading** | Mirror a target account or wallet with proportional sizing and caps |
| **On-chain yield** | Wallet-keyed accounts on lending, LP, and yield-tokenization protocols |
| **On-chain arbitrage** | DEX-to-DEX and DEX-to-CEX price gaps, executed from wallet accounts |
| **Airdrop farming** | Scheduled protocol interactions across many wallets, each an account |
| **Launch sniping / new listings** | Monitor listings and token launches, enter on the event with size caps |
| **Meme trading** | Fast on-chain momentum with hard stops and position limits |
| **News / social signals** | Monitors over news feeds and social posts (X, Telegram), LLM-classified, traded with limits |
| **AI-driven signals** | Structured-output LLM inference as one input among the others, risk limits in code |

---

## Packages

`framework/` engine and domains · `venues/` exchange integrations · `apps/` gateway and dashboard · `strategies/` reference plugins.

| Package | Role |
|---|---|
| [`@openwhaleorg/core`](./packages/framework/core) | Engine: adapter matrix, accounts, monitor model, strategy/executor/trigger, run traces, PnL attribution, scripts, `definePlugin` and decorators |
| [`@openwhaleorg/exchange`](./packages/framework/exchange) | Kinds `exchange/perp` and `exchange/spot`: account views, trading executors, market monitors |
| [`@openwhaleorg/web3`](./packages/framework/web3) | Kind `web3/chain`: EVM session, wallet account, `web3/evm` and `web3/rpc` credential types |
| [`@openwhaleorg/ccxt-adapter`](./packages/venues/ccxt-adapter) | ccxt implementation of the exchange adapters and the data-driven venue roster |
| [`@openwhaleorg/hyperliquid`](./packages/venues/hyperliquid) / [`binance`](./packages/venues/binance) / [`aster`](./packages/venues/aster) | Venue plugins: credential types, adapter cells, venue-specialized accounts |
| [`@openwhaleorg/gateway`](./packages/apps/gateway) | Backend: runtime, auth, REST + SSE API, compiler service, plugin install |
| [`@openwhaleorg/dashboard`](./packages/apps/dashboard) | Next.js frontend |
| [`@openwhaleorg/examples`](./packages/strategies/examples) | Reference strategies: momentum, mean reversion, DCA, LLM analyst, copy trading |
| [`@openwhaleorg/compiler`](./packages/framework/compiler) | NL → code → validation ladder → review → hot load |

Release check: `pnpm check:publish` packs every package and verifies the peer ranges inside the tarballs (`workspace:^` is resolved at pack time and appears nowhere in the repo).

---

## Contributing

Issues for ideas and bugs; PRs for fixes, venue plugins and strategy examples.

## License

MIT
