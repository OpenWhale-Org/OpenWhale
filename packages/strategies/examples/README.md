# @openwhaleorg/examples

Reference strategies for OpenWhale — readable, tested, and **venue-agnostic by
construction**. None of them names an exchange: each declares a perp account
slot, and the venue comes from whichever account you bind at activation. Bind
Binance and it trades Binance; bind Hyperliquid and the same code trades
Hyperliquid.

The package is loaded by the gateway out of the box, so the strategies appear
in the dashboard's instance form with no install step.

| Strategy | id | Idea | Trigger |
|---|---|---|---|
| Momentum Breakout | `examples/momentum-breakout` | Donchian channel breakout — long above the channel, exit (or flip) below a faster one | klines monitor |
| Mean Reversion | `examples/mean-reversion` | Fade moves beyond ±z standard deviations, flatten as the z-score decays | klines monitor |
| Scheduled Accumulation | `examples/scheduled-accumulation` | DCA a fixed USD clip on a cron, bigger clips below the average, stop at a target | cron |
| AI Market Analyst | `examples/ai-analyst` | An LLM returns a structured verdict; code scales and caps the order | cron |
| Copy Trading | `examples/copy-trading` | Mirror another address's fills at a ratio | Hyperliquid fills monitor |

## Two rules every example follows

**Risk lives in code, never in a signal.** Every strategy reads its position
from the venue each evaluation and sizes through `sizeAgainstCap()`: an order
that would breach `maxPositionUsd` is trimmed, and an order opposing an open
position is capped at that position (reduce-only) so it can flatten but never
flip through zero. This matters most in `ai-analyst`, where the model chooses a
direction and a confidence — and nothing else. An LLM in the decision path is
useful; an LLM in the risk path is a liability.

**Monitors are declared, not assumed.** A strategy triggered by a monitor
declares it in `triggers()`; one that decides on its own schedule declares the
feed in `subscriptions()` so the data keeps collecting without waking
`evaluate()`. `scheduled-accumulation` and `ai-analyst` show the second shape.

## Setup

Each strategy tells you which monitor instance it needs — create it on the
Monitor page before activating:

- `momentum-breakout`, `mean-reversion`, `ai-analyst` → an `exchange/klines`
  instance for `venue:symbol:timeframe`, with a timeframe matching the
  strategy's param.
- `scheduled-accumulation` → an `exchange/ticker` instance for `venue:symbol`.
- `copy-trading` → nothing to create (the Hyperliquid fills monitor is
  credential-less and auto-activates), but `@openwhaleorg/hyperliquid` must be
  loaded, and the target address goes in the strategy params.
- `ai-analyst` also needs an LLM credential bound to its `decision` slot; the
  model defaults to `anthropic:claude-haiku-4-5` and is overridable per
  instance.

Every strategy defaults to real orders — there is no dry-run flag here. Start
with a small `notionalUsd` and a small `maxPositionUsd`, or point the account
at a testnet credential.

## Assembling a runtime in code

`runnable/copy-trading.ts` builds a gateway-less runtime end to end: create the
database and credential store, load plugins, activate an instance, shut down
cleanly. `MOCK_EXECUTOR=true` swaps the perp executor for a logger that never
trades.

```bash
pnpm --filter @openwhaleorg/examples run:copy-trading
```

## Copying one into your own plugin

Each strategy file is self-contained apart from `indicators.ts` (pure
functions: `sma`, `stdev`, `zScore`, `donchian`, `atr`, `signedExposure`,
`sizeAgainstCap` — all unit-tested). Copy the file, copy the helpers you use,
rename the class and `strategyId`, and list it in your own `definePlugin`.
`src/__tests__/strategies.test.ts` shows how to test one offline: stub the
monitor reader and the account, and assert on the emitted instructions — no
venue, no database, no network.
