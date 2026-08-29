# Writing an Executor

An executor is a singleton service that consumes instructions from the queue and acts on venues.
It declares **named credential slots**; the CALLING strategy instance's bindings satisfy them at
execution time (executors are never instantiated per user). Slots resolve to either a full
session (write-capable venue connection) or raw credential data.

## Complete template

```ts
import { z } from 'zod'
import { BaseExecutor, OwExecutor, createLogger } from '@openwhaleorg/core'
import type { ExecutionInstruction, ExecutionResult, ExecutorCredentialSlot } from '@openwhaleorg/core'
import type { PerpExchangeAdapter } from '@openwhaleorg/exchange'

const paramsSchema = z.object({
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  notionalUsd: z.number().positive(),
})

const instructionSchema = z.object({
  messageId: z.string(),
  executorId: z.string(),
  action: z.string(),
  params: paramsSchema,
  instanceId: z.string().optional(),
  accountNames: z.array(z.string()).optional(),
})
type MyInstruction = ExecutionInstruction & { params: z.infer<typeof paramsSchema> }

@OwExecutor({ name: 'Simple Trader', description: 'Places one market order per instruction' })
export class SimpleTradeExecutor extends BaseExecutor<MyInstruction> {
  constructor(options?: { dataDir?: string }) {
    super({
      timeout: 60_000,                                    // 0 = no timeout (long cycles)
      retry: { maxRetries: 2, retryDelay: 500, maxRetryDelay: 30_000 },
      maxConcurrent: 4,
      ...(options?.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    })
  }

  get executorName(): string { return 'simple-trade' }    // registry id (plugin-qualified at load)
  get supportedActions(): string[] { return ['placeOrder', 'simulate'] }

  // Slot needs — satisfied by the calling strategy's bound accounts (matching kind).
  override get credentials(): readonly ExecutorCredentialSlot[] {
    return [{ label: 'trading', kind: 'exchange/perp' }]
    // Raw-credential slot (e.g. a bot token): { label: 'notify', type: 'telegram', raw: true }
    // Add optional: true and the instance may activate WITHOUT binding it — read with
    // this.rawIfBound('notify') (undefined = unbound) and return a clear failed result
    // instead of throwing. Use for side-channel executors gated by a strategy toggle.
  }

  // Per-action param schemas → Dashboard "manual fire" forms + validation.
  override get actionSchemas() { return { placeOrder: paramsSchema, simulate: paramsSchema } }
  protected override get instructionSchema() { return instructionSchema as never }

  async execute(instruction: MyInstruction): Promise<ExecutionResult<MyInstruction>> {
    const { symbol, side, notionalUsd } = instruction.params
    const simulate = instruction.action === 'simulate'
    const session = this.session<PerpExchangeAdapter>('trading')   // FULL body — read + write

    const price = (await session.fetchTicker(symbol)).last
    if (!price || price <= 0) {
      return { instruction, status: 'failed', error: `No price for ${symbol}`, executedAt: new Date() }
    }

    if (!simulate) {
      const amount = await session.amountToPrecision(symbol, notionalUsd / price)
      await session.createOrder({
        symbol, side, type: 'market', amount,
        clientOrderId: `0x${instruction.messageId.slice(0, 30)}`,  // idempotency across retries
      })
    }

    return {
      instruction, status: 'success',
      data: { symbol, side, price, simulated: simulate },
      executedAt: new Date(),
    }
  }
}
```

## Essentials

- `this.session<T>('label')` — the slot's session for the CURRENT instruction (resolved from the
  calling instance's bindings). `this.raw('label')` for `raw: true` slots;
  `this.rawIfBound('label')` for `optional: true` raw slots (undefined when unbound).
- **PnL attribution is convention-based**: put `{ orderId, symbol }` on the same object anywhere
  in the result's `data` (nested is fine, depth ≤ 6) for EVERY order you place — including
  resting/protective orders — and the framework claims them for the calling instance. Venue fills
  and funding then attribute automatically; an order you forget shows up as unattributed.
  By default every order is attributed to the instruction's FIRST account. A multi-slot executor
  (one order per account — a pair leg on each venue) names the account on each order object:
  `{ orderId, symbol, accountIndex: 1 }` (index into the instruction's `accountNames`, in slot
  order) or `{ orderId, symbol, accountName: instruction.accountNames![1] }`; an object without
  either keeps the first-account default.
- **Return an `ExecutionResult` — always.** The framework writes it to
  `dataDir/executions/{executorName}/{date}.jsonl`, which feeds the Dashboard's execution history.
  An `execute()` that never returns (infinite retry loop) means NO record — bound the work, and
  verify venue state (e.g. positions) instead of retrying an impossible order forever.
- Retries: the framework retries `execute()` on throw per `retry` options. If replaying the whole
  function is wrong (multi-step cycles), set `maxRetries: 0` and retry per-step inside, with
  **deterministic client order ids** (derive from `messageId`) so a retried order is found, not
  duplicated (`fetchOrderByClientId` before resubmitting).
- Queue semantics: per-instance serial by default; `maxConcurrent` opts into parallelism.
- Long cycles are fine (`timeout: 0`): an executor may sleep until a scheduled moment — this is
  where timing lives (strategies must return promptly).
- Instructions carry `accountNames` when the strategy passed account labels; multi-slot executors
  map slots by order.

## Dry-run convention

Support a `simulate` action mirroring the real one: identical timeline/pricing, zero orders,
result data reporting simulated fills/PnL. Strategies emit `simulate` when their `dryRun` param
is on. This is what makes a strategy testable end-to-end from the Dashboard.
