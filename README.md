# OpenWhale

<img src="./logo.svg" width="64" height="64" />

**The programmable layer for composable, AI-native economic strategies**

![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

OpenWhale is a TypeScript framework for building automated economic strategies. Monitors, Strategies, and Executors are fully decoupled — the same strategy code runs on any venue, plugs into any data source, and can be written, audited, and evolved by an AI.

---

## Why OpenWhale

- **Fully decoupled layers** — Monitors collect, Strategies decide, Executors act. Replace any layer without touching the others.
- **Venue-agnostic by construction** — a strategy never names an exchange. It declares *account slots*; the venue derives from whichever account you bind at activation. One strategy, any platform.
- **The adapter matrix** — venues plug in as cells of a *(kind × venue)* matrix (`exchange/perp × binance`, `exchange/spot × hyperliquid`, …). Domain packages define the vocabulary, venue packages fill the cells, and a data-driven ccxt roster ships twelve venues out of the box.
- **AI as a programmer** — LLM inference with structured output is built into the strategy layer, and the repo ships a `skills/openwhale-dev` skill that teaches any Claude the full framework contract so it can produce installable plugins with tests.
- **Deep observability** — every strategy run leaves a persistent decision trace: what it saw, which gate said no, what it emitted. Deactivate an instance or restart the gateway and the audit trail survives.
- **PnL attribution built in** — executors auto-claim the orders they place; a background collector joins venue fills (ground-truth realized PnL and fees) and funding income back to the claiming instance. Two instances trading the same symbol on the same account stay separable.
- **Type-safe plugin architecture** — every component implements a strict TypeScript interface. IDE support, safe refactoring, and AI-generated code the compiler validates.

---

## Core concepts

| Concept | What it is |
|---|---|
| **Monitor** | Collects data and emits keyed records (`venue:symbol`, …). Declared as a *contract* with one or more *implementations*; users create per-key *instances*, optionally credential-bound. Emits persist as JSONL and drive triggers. |
| **Strategy** | Pure decision logic. Declares monitor/executor/account dependencies by label, receives triggers, returns `ExecutionInstruction[]`. Params split into `base` (required) and `tunable` (defaulted, AI-optimizable) zod schemas. |
| **Executor** | Turns instructions into venue actions through adapter sessions: retry discipline, idempotent client order ids, per-order latency and slippage capture. Credential slots resolve to sessions (by kind) or raw credential data (`raw: true` — e.g. a bot token); `optional: true` slots let instances activate unbound and the executor degrade gracefully. Strategies stay pure. |
| **Instance** | A strategy + params + account bindings, activated as a unit. Everything observable hangs off the instance: live events, executions, run traces, logs. |
| **Account** | A named entity binding a credential to an account implementation (generic or venue-specialized). Strategies read balances and positions only through their bound account's Reader. |
| **Trigger** | Cron schedules and monitor conditions (multi-source AND within a time window). Subscriptions keep monitors collecting without waking the strategy; a live strategy can add sources it discovers at runtime (`addMonitorSource`). |
| **Portfolio journal** | Optional instance-scoped history owned by a strategy. Strategies commit idempotent snapshots, fills, decisions, and market bars; Core stores them transactionally and derives equity, drawdown, and trade reports without knowing the strategy's trace format. |

```
Monitor (data collection)
    ↓ emit(key, data)
TriggerManager (cron + monitor conditions)
    ↓ StrategyContext
Strategy (rules / AI inference)  →  run trace persisted
    ↓ ExecutionInstruction[]
ExecutionQueue
    ↓
Executor (venue actions via adapter sessions)
```

---

## The dashboard

- **Instances** — cards with folders, drag-drop ordering, emoji icons, and a live net-PnL badge per card; four live tabs per instance (Live Events scoped to the instance's own monitors, Executions, Runs, Logs). A full-page **Board** per instance adds click-to-rename, account rebinding, an editable parameter panel, and a PnL panel.
- **Per-instance PnL** — realized / fees / funding / net / unrealized cards backed by the attribution ledger, with drill-down tabs for by-symbol totals, raw venue fills, and fill-derived open positions priced at the venue mark. Funding events split across instances by the position each held at the settlement boundary.
- **Run tracing** — every run records its steps: gates, skips, sizing, emitted instructions, captured log lines. Runs with instructions or errors persist to disk; idle runs are heartbeat-sampled. Filter by outcome, search by content.
- **Monitor boards** — monitors declare dashboard panels via the `plots()` convention: line/bar/candles plus a sortable `table` kind, single- and multi-select pickers, record-window control.
- **Params as forms** — zod `.meta()` drives the UI: sections, sliders, unit suffixes, conditional visibility, searchable market pickers (single and multi), per-value availability verdicts against the bound venue, editable row-table *list* params for ladders, and sandboxed interactive *illustrations* that redraw live as you edit values.
- **Scripts** — plugins ship operator utilities (`scripts: [...]`) that run on demand against the live runtime and return a monospace report: plan previews, fit inspectors, one-off audits. Params render as a small form, with live-resolved dropdowns for runtime values such as instance ids.
- **Compiler & Assistant** — an experimental natural-language strategy compiler, plus the recommended path: point Claude at `skills/openwhale-dev` and have it write the plugin.

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
    this.trace('tick:read', { tick })                    // lands in the run trace
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

A plugin is a package with a default-exported factory returning its registrations:

```typescript
export default definePlugin((ctx) => ({
  name: 'my-plugin',
  version: '1.0.0',
  monitorImplementations: [ /* contract / implementation / instance model */ ],
  executors: [ /* … */ ],
  strategies: [ /* … */ ],
  scripts: [ /* operator utilities for the Scripts page */ ],
  credentialTypes: [ /* venue credential recipes: schema, raw opt-in, connectivity test */ ],
  adapters: [ /* (kind × venue) matrix cells */ ],
  accounts: [ /* account implementations */ ],
}))
```

Install from the dashboard's Plugins page — a built `.js`/`.mjs` bundle, a **GitHub repository** (`owner/repo`, or paste the address bar; optional branch/tag/commit), or an npm name or local path — or `runtime.loadPlugin()` in code. Components register namespaced (`my-plugin/momentum`); hot reload is supported.

A GitHub install is cloned and built by npm, so a repo shipping only TypeScript sources needs a `prepare` script in its package.json (`"prepare": "npm run build"`); private repos need `OPENWHALE_GITHUB_TOKEN` set on the engine.

Uninstalling refuses while any strategy instance, account or credential still belongs to the plugin — each holds something you configured — and names them. The plugin's monitor instances are deleted with it. Each install is loaded from its own copy under `plugins/staged/`, so reinstalling runs the new code without restarting the engine: Node's ESM registry is keyed by resolved URL and cannot be evicted, so a fixed path would keep executing the first version loaded.

### Writing plugins with Claude

Copy `skills/openwhale-dev/` into your plugin project's `.claude/skills/` (or reference this repo's path in Claude Code), describe the strategy you want, and Claude produces a complete plugin package — monitors, executors, strategies, tests — that installs from the Plugins page.

---

## Use cases

| Scenario | Description |
|----------|-------------|
| **Funding / basis capture** | Cron-triggered cycles around settlement instants, sized by order-book depth, timed against fitted market microstructure |
| **Pair / spread reversion** | Two-leg hedged ladders driven by a z-scored spread monitor, with dwell confirmation and stop discipline |
| **Copy trading** | Monitor a target wallet, mirror its trades proportionally with position caps |
| **AI market analysis** | LLM inference with structured output directly inside `evaluate()` |
| **Multi-condition signals** | Combine price, volume, and rate monitors — fire only when all conditions align within a time window |

---

## Quick start

### Prerequisites

- Node.js ≥ 20, pnpm ≥ 9

### Gateway + Dashboard

The backend (gateway) owns the runtime and all secrets; the dashboard is a pure frontend.

```bash
pnpm install
pnpm build
cp .env.example .env           # fill in OPENWHALE_MASTER_KEY + OPENWHALE_ADMIN_USER/PASSWORD
pnpm dev                       # gateway on :3001 + dashboard on :3000
```

The gateway **fails closed**: with no user account and no
`OPENWHALE_ADMIN_USER`/`OPENWHALE_ADMIN_PASSWORD` it refuses to start rather
than serve an unauthenticated trading API. Set them once, sign in, then remove
them from the environment.

Open `http://localhost:3000` to manage strategy instances, accounts, monitors, credentials, scripts, and the AI compiler. The dashboard's only setting is `OPENWHALE_GATEWAY_URL` (defaults to `http://localhost:3001`).

### Behind a proxy

Where the exchanges are unreachable directly, point venue traffic at a proxy:

```bash
OPENWHALE_HTTPS_PROXY=http://127.0.0.1:7897        # REST + WebSocket, every venue
OPENWHALE_HTTPS_PROXY_BINANCEUSDM=off              # …except this one
```

The per-venue suffix is the **ccxt exchange id**, upper-cased — Binance perp is
`BINANCEUSDM`, Binance spot is `BINANCE`. `off` keeps a venue direct, which
matters more than it looks: settlements are raced by the millisecond, so a venue
you *can* reach directly should not be paying proxy hops for a setting aimed at
the ones you cannot.

Two things are worth knowing before debugging this yourself. The standard
`HTTPS_PROXY` does nothing — ccxt does not read it. Neither does Node 24's
`NODE_USE_ENV_PROXY`, which only wires undici's *global* fetch while ccxt calls
its own bundled one; a plain `fetch()` in the same process will succeed and make
the failure look like anything but a proxy problem. And the variable is
deliberately not named `HTTPS_PROXY`: plenty of machines carry that for
unrelated reasons, and order traffic should never change route by accident.

### Authentication

Auth is enforced by the **gateway**, not the dashboard: that process holds the
decrypted venue credentials, can place orders, and can install plugins
(arbitrary code), so a frontend-only login would be bypassed by anyone who can
reach port 3001. Every `/api/*` route requires a session; the dashboard just
carries the cookie, and its route guard is a redirect for humans rather than a
security boundary.

Sessions are opaque tokens in SQLite (revocable, 7-day expiry) and passwords are
scrypt-hashed. Manage accounts on the **Users** page — there are no roles: anyone
who can sign in can move real money.

Before exposing the gateway to a network:

- terminate TLS in front of it (the session cookie is marked `Secure` only when
  the request arrives over https)
- keep port 3001 off the public internet if the dashboard proxies for you; set
  `OPENWHALE_ALLOWED_ORIGIN` only for genuinely cross-origin frontends

---

## Packages

Grouped by role — `framework/` (engine, domain, compiler), `venues/` (exchange
integrations), `apps/` (gateway, dashboard), `strategies/` (reference and
private strategy plugins).

| Package | Description |
|---------|-------------|
| [`@openwhaleorg/core`](./packages/framework/core) | Domain-agnostic engine: credential materialization, adapter matrix, first-class Accounts, monitor contract/implementation/instance model, Strategy/Executor/Trigger, run-trace persistence, PnL attribution (order claims + fill/funding collector), Scripts, `definePlugin` + `@Ow*` decorators, CompiledLoader |
| [`@openwhaleorg/exchange`](./packages/framework/exchange) | Exchange domain package: kinds `exchange/perp` + `exchange/spot`, Perp/SpotAccount read views, shared trading executors, public market monitors (ticker/orderbook/volume/kline/funding-rates) with dashboard plots |
| [`@openwhaleorg/ccxt-adapter`](./packages/venues/ccxt-adapter) | Generic ccxt implementation of the exchange adapter interfaces + the data-driven venue roster |
| [`@openwhaleorg/hyperliquid`](./packages/venues/hyperliquid) / [`binance`](./packages/venues/binance) / [`aster`](./packages/venues/aster) | Venue plugins: credential types + adapter cells (+ venue-specialized accounts, Portfolio Margin support on Binance) |
| [`@openwhaleorg/gateway`](./packages/apps/gateway) | Resident backend: runtime singleton, auth, REST + SSE API, compiler service, plugin install — all secrets live here |
| [`@openwhaleorg/dashboard`](./packages/apps/dashboard) | Next.js frontend: instances (folders/boards), accounts (equity curves), monitor boards, executors, credentials, plugins, scripts, AI compiler |
| [`@openwhaleorg/examples`](./packages/strategies/examples) | Reference strategies, venue-agnostic by construction: momentum breakout, z-score mean reversion, scheduled accumulation (DCA), an LLM analyst whose risk lives in code, and copy trading. Read them, copy them |
| [`@openwhaleorg/compiler`](./packages/framework/compiler) | AI strategy compiler: NL → analyze → codegen → L1–L4 validation ladder → human review → hot load |

---

## Roadmap

### M1 — Compiler *(shipped)*

A conversational compiler that guides users step by step to define strategy logic, then compiles Monitor / Strategy / Executor components into type-safe TypeScript. Runs a deterministic validation ladder (build → typecheck → registration probe → mock dry-run) automatically. After human review, hot-loads the result into the runtime.

### M2 — Optimizer

Dual-agent optimization loop: an analysis agent reads runtime performance and historical monitor data to generate an optimization plan; an execution agent adjusts parameters or rewrites strategy code and validates the result through backtesting.

### M3 — Assistant

A unified conversational interface for the full strategy lifecycle: create and manage instances, trigger the Compiler and Optimizer, receive proactive alerts and performance reports.

### M4 — MCP Server

Expose the core engine capabilities as standard MCP tools, enabling external AI agents to drive strategy creation, activation, and optimization directly.

---

## Contributing

OpenWhale is in active early development. The core engine is working, and we're building the rest in the open.

- Open an issue to discuss ideas or report bugs
- Submit a PR for fixes, new venue plugins, or strategy examples
- Star the repo if you find it useful — it helps others discover the project

---

## License

MIT
