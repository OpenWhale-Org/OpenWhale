# OpenWhale

**The programmable layer for composable, AI-native economic strategies**

![License](https://img.shields.io/badge/license-MIT-blue)
![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

OpenWhale is a TypeScript framework for building automated economic strategies. Monitor, Strategy, and Executor are fully decoupled — the same strategy code runs on any exchange, plugs into any data source, and can be generated or evolved by an AI at runtime.

---

## Why OpenWhale

Most strategy frameworks couple data collection, decision logic, and execution into a single monolith. Swapping an exchange or adding a new data source means rewriting core logic. AI integrations are bolted on as "decision makers" that consume tokens on every tick — not as programmers that produce reusable, auditable code.

OpenWhale is built differently:

- **Fully decoupled layers** — Monitor, Strategy, and Executor are independent. Replace any layer without touching the others.
- **Exchange-agnostic strategies** — Strategy code has zero knowledge of which exchange it runs on. One strategy, any platform.
- **AI as a programmer** — LLM inference is built into the strategy layer. AI generates type-safe TypeScript strategies that are compiled, hot-loaded, and can evolve automatically — no token cost per tick.
- **Structured trigger system** — Combine Cron schedules with multi-source Monitor conditions (AND logic, time window). Express "fire only when A and B both happen within 60 seconds" without polling.
- **Type-safe plugin architecture** — Every Monitor, Executor, and Strategy implements a strict TypeScript interface. IDE support, safe refactoring, and AI-generated code that the type system validates at compile time.

---

## Code Examples

### A minimal strategy

```typescript
import { BaseStrategy, type StrategyContext } from '@openwhale/core'
import { z } from 'zod'

class MomentumStrategy extends BaseStrategy {
  readonly strategyId = 'momentum'
  readonly monitors = [{ name: 'price', label: 'price' }] as const
  readonly executors = [{ name: 'perp-trading', label: 'perp' }] as const
  readonly accountTypes = [{ type: 'hyperliquid', label: 'main' }] as const

  readonly baseParamsSchema = z.object({
    symbol: z.string().meta({ displayName: 'Symbol', placeholder: 'BTC/USDC:USDC' }),
    threshold: z.number().meta({ displayName: 'Price Threshold' }),
  })

  async evaluate(context: StrategyContext) {
    const { symbol, threshold } = this.baseParamsSchema.parse(this.params.base)
    const tick = context.getData('price', symbol)
    if (!tick || tick.price < threshold) return []

    return [this.instruction('perp', 'placeOrder', {
      symbol, side: 'buy', type: 'market', amount: 0.01,
    })]
  }
}
```

### Assembling the runtime

```typescript
import { OpenWhaleRuntime, SQLiteAdapter, DBCredentialStore } from '@openwhale/core'
import { hyperliquidPlugin } from '@openwhale/hyperliquid'

const database = new SQLiteAdapter({ filePath: './data/openwhale.db' })
const credentialStore = new DBCredentialStore(process.env.MASTER_KEY!, database)
const runtime = new OpenWhaleRuntime({ database, credentialStore })

runtime.loadPlugin(hyperliquidPlugin, { /* config */ })

await runtime.start()
await runtime.activate({
  id: 'instance-1',
  strategyId: 'hyperliquid/copy-trading',
  accounts: ['HL Main'],
  params: {
    base: { targetAddress: '0x...', ratio: 0.5, maxPositionUsd: 1000 },
  },
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})
```

### AI-driven strategy with structured output

```typescript
class AiStrategy extends BaseStrategy {
  readonly strategyId = 'ai-momentum'

  constructor() {
    super({ llm: { defaultModel: 'anthropic:claude-sonnet-4-6' } })
  }

  async evaluate(context: StrategyContext) {
    const marketData = context.getData('price', 'BTC/USDC:USDC')

    const decision = await this.llm({
      messages: [
        { role: 'system', content: 'You are a trading analyst. Respond with a structured decision.' },
        { role: 'user', content: JSON.stringify(marketData) },
      ],
      schema: z.object({
        action: z.enum(['buy', 'sell', 'hold']),
        reason: z.string(),
        confidence: z.number().min(0).max(1),
      }),
    })

    if (decision.action === 'hold' || decision.confidence < 0.7) return []

    return [this.instruction('perp', 'placeOrder', {
      symbol: 'BTC/USDC:USDC',
      side: decision.action,
      type: 'market',
      amount: 0.01,
    })]
  }
}
```

---

## Features

- **Plugin architecture** — exchanges, account types, monitors, and executors register through standard interfaces; the framework manages lifecycle and dependency injection
- **Composable by design** — Monitor / Strategy / Executor mix and match freely; swap `MockExecutor` for simulation with one line
- **Exchange-agnostic strategies** — strategies access accounts through `IAccount` and express intent through `ExecutionInstruction`, never calling exchange SDKs directly
- **Built-in LLM inference** — call LLMs with structured output (Zod schema) directly inside strategy `evaluate()`; supports OpenAI, Anthropic, Google, Groq, xAI, and custom providers
- **Structured trigger system** — Cron + Monitor condition AND combinations with time windows; `TriggerManager` handles all scheduling and state
- **Auto-derived param UI** — attach `.meta()` to Zod schema fields; Dashboard renders typed form controls automatically, no per-strategy UI code needed
- **Hot-reload compiled strategies** — AI-generated TypeScript strategies are compiled with esbuild and loaded at runtime without restart
- **Persistent storage** — Monitor data auto-persisted as JSONL; built-in KV store per strategy instance; SQLite adapter included

---

## Use Cases

| Scenario | Description |
|----------|-------------|
| **Copy Trading** | Monitor a target wallet, mirror its trades proportionally with position caps |
| **Cross-exchange Arbitrage** | Trigger only when price spread AND funding rate conditions are met simultaneously |
| **AI Market Making** | LLM analyzes order book depth and volatility, dynamically adjusts bid/ask quotes |
| **On-chain Event Response** | Listen to smart contract events, trigger on-chain or off-chain actions automatically |
| **Multi-condition Signal Strategy** | Combine price, volume, and funding rate monitors — fire only when all conditions align within a time window |
| **NFT / Token Launch Sniping** | Monitor mempool or launchpad events, execute within milliseconds of a trigger |
| **Yield Optimization** | Monitor APY across protocols, rebalance positions when spread exceeds threshold |

---

## Architecture

```
Monitor (data collection)
    ↓ emit(key, data)
TriggerManager (trigger evaluation)
    ↓ StrategyContext
Strategy (rules / AI inference)
    ↓ ExecutionInstruction[]
ExecutionQueue
    ↓
Executor (trade execution)
```

Each layer is a pure interface. Monitors emit keyed data events. TriggerManager evaluates Cron + Monitor conditions and fires a `StrategyContext`. Strategies return `ExecutionInstruction[]` — they never call exchange APIs directly. Executors consume the queue and handle the actual API calls.

---

## Quick Start

### Prerequisites

- Node.js ≥ 20, pnpm ≥ 8
- A Hyperliquid account with a wallet address and private key

### Install

```bash
pnpm install
pnpm build
```

### Run the copy trading example

```bash
cd packages/hyperliquid
cp examples/.env.example examples/.env
```

Edit `examples/.env`:

```env
HL_WALLET_ADDRESS=0x...        # your wallet address
HL_PRIVATE_KEY=0x...           # your private key
HL_TARGET_ADDRESS=0x...        # address to copy trades from
MASTER_KEY=your-32-byte-hex    # encryption key for credential store
```

```bash
pnpm example:copy-trading
```

### Dashboard

```bash
cd packages/dashboard
cp .env.example .env.local     # fill in OPENWHALE_MASTER_KEY
pnpm dev
```

Open `http://localhost:3000` to manage strategy instances, view monitor data, and configure credentials.

---

## Packages

| Package | Description |
|---------|-------------|
| [`@openwhale/core`](./packages/core) | Strategy engine core: Monitor, Trigger, Strategy, Executor, Runtime, Account, CompiledLoader |
| [`@openwhale/hyperliquid`](./packages/hyperliquid) | Hyperliquid plugin: HyperliquidAdapter (ccxt.pro), HyperliquidAccount, UserTradesMonitor, PerpTradingExecutor, CopyTradingStrategy |
| [`@openwhale/dashboard`](./packages/dashboard) | Next.js management dashboard: strategy instance management, registry browser, credential management, auto-rendered param forms |
| `@openwhale/assistant` | Personal assistant layer: session management, LLM conversation, tool calls *(planned)* |
| `@openwhale/mcp-server` | Expose the strategy engine as an MCP server *(planned)* |

---

## Roadmap

### M1 — Compiler

A conversational compiler that guides users step by step to define strategy logic, then compiles Monitor / Strategy / Executor components into type-safe TypeScript. Runs static analysis, unit tests, and mock simulation automatically. Hot-loads the result into the runtime — ready to run out of the box.

### M2 — Optimizer

Dual-agent optimization loop: an analysis agent reads runtime performance and historical monitor data to generate an optimization plan; an execution agent adjusts parameters or rewrites strategy code and validates the result through backtesting. Triggered automatically on a schedule, manually from the Dashboard, or conversationally through the Assistant.

### M3 — Assistant

A unified conversational interface for the full strategy lifecycle: create and manage instances, trigger the Compiler to build new strategies, trigger the Optimizer to tune existing ones, receive proactive alerts and performance reports. Includes basic information retrieval — market data, on-chain activity, news feeds, signal sources.

### M4 — MCP Server

Expose the core engine capabilities as standard MCP tools, enabling external AI agents to drive strategy creation, activation, and optimization directly.

---

## Contributing

OpenWhale is in active early development. The core engine is working, and we're building the rest in the open. If you're a developer interested in composable strategy infrastructure, AI-native trading systems, or just want to run your own automated strategies — we'd love your contributions.

- Open an issue to discuss ideas or report bugs
- Submit a PR for fixes, new exchange plugins, or strategy examples
- Star the repo if you find it useful — it helps others discover the project

---

## License

MIT
