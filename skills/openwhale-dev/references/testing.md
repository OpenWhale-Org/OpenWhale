# Testing OpenWhale Components

Everything is testable offline with vitest — no gateway, no venue, no credentials. The framework
classes accept injected fakes for every dependency. Ship tests with every component.

Config reminder: `vitest.config.ts` needs `esbuild: { target: 'es2022' }` (decorators).

## Strategy harness

```ts
import { describe, it, expect } from 'vitest'
import type { StrategyContext, IStrategyStore } from '@openwhaleorg/core'
import { MyStrategy } from '../strategy/MyStrategy.js'

class MemStore implements IStrategyStore {
  data = new Map<string, unknown>()
  async get<T>(key: string) { return this.data.get(key) as T | undefined }
  async set(key: string, value: unknown) { this.data.set(key, value) }
  async delete(key: string) { this.data.delete(key) }
  async has(key: string) { return this.data.has(key) }
  async keys() { return [...this.data.keys()] }
  async clear() { this.data.clear() }
}

// Fake account read view — only the methods your strategy calls.
const fakeReader = {
  balance: async () => ({ usd: { available: 5_000, total: 5_000 }, tokens: [] }),
}

// Fake MonitorDataReader for this.monitorData('label') consumers.
function fakeMonitorReader(latest: unknown, last: unknown[] = []) {
  return {
    keys: async () => ['fake'],
    readLast: async () => last,                 // records are { ts, data }
    readLatest: async () => (latest === undefined ? null : { ts: Date.now(), data: latest }),
    readRange: async () => last,
    count: async () => last.length,
    stream: (async function* () {})() as never,
  } as never
}

function makeStrategy(base: Record<string, unknown>, tunable: Record<string, unknown> = {}) {
  const strategy = new MyStrategy()
  const store = new MemStore()
  strategy.setStore(store)
  strategy.setParams({ base, tunable })
  strategy.setReaders([fakeReader], ['Fake Main'])                       // slot order = decls order
  strategy.setAccountMeta([{ label: 'main', accountName: 'Fake Main',   // what the runtime injects
                             venue: 'fake', kind: 'exchange/perp' }])
  strategy.setMonitorReader('somefeed', fakeMonitorReader(undefined))   // per declared label
  return { strategy, store }
}

function contextWith(data: unknown, label = 'rates', key = 'fake'): StrategyContext {
  return {
    instanceId: 'inst', triggerId: 'trig', timestamp: Date.now(), monitorData: {},
    getData: (l: string, k: string) => (l === label && k === key ? data : undefined),
  } as unknown as StrategyContext
}

it('emits on signal', async () => {
  const { strategy } = makeStrategy({ capitalUsd: 1_000 })
  const out = await strategy.evaluate(contextWith({ /* the monitor record */ }))
  expect(out).toHaveLength(1)
  expect(out[0]!.action).toBe('simulate')   // dryRun defaults true
})
```

Test at minimum: the happy path (exact numbers from a worked example), every entry gate, the
dryRun/live switch, and idempotency (same trigger twice → second returns `[]`).

## Executor harness

```ts
import { MemoryExecutionQueue } from '@openwhaleorg/core'
import type { ExecutionInstruction } from '@openwhaleorg/core'
import fs from 'fs'; import path from 'path'; import os from 'os'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-test-'))

// Fake session: implement exactly what execute() calls, script failures per test.
function makeSession() {
  const placed: unknown[] = []
  return {
    placed,
    fetchTicker: async (symbol: string) => ({ symbol, last: 100 }),
    amountToPrecision: async (_s: string, a: number) => a,
    createOrder: async (p: unknown) => { placed.push(p); return { id: '1', filled: 1, status: 'closed', average: 100 } },
    fetchPositions: async () => [],
  }
}

async function runInstruction(executor: MyExecutor, session: unknown, params: Record<string, unknown>, action = 'placeOrder') {
  executor.setMaterialized('inst', [{ label: 'trading', credentialName: 'Fake', session }])
  const queue = new MemoryExecutionQueue()
  const consuming = executor.run(queue, 'my-exec')
  await queue.push({ messageId: `m-${Math.random()}`, executorId: 'my-exec', action, params, instanceId: 'inst' } as ExecutionInstruction)
  // Poll the JSONL record file under `${tmpDir}/executions/{executorName}/` until a new line appears,
  // then: await queue.stop(); await consuming; return the parsed record.
}
```

Construct the executor with `new MyExecutor({ dataDir: tmpDir })` so records land in the temp dir.
Assert on the parsed record (`status`, `data`) AND on `session.placed` (what actually hit the
venue). Cover: success, a failing leg not affecting others, retry/idempotency (failed call →
lookup finds it landed → no duplicate), and simulate placing zero orders.

## Monitor tests

Instantiate with a temp dataDir, call `startSubscribe(key)` against a faked source, and poll
until the expected emit arrives (never fixed sleeps — flaky):

```ts
async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error('timeout')
    await new Promise(r => setTimeout(r, 25))
  }
}
```

Read back what was written via the monitor's own reader (`getReader()` / reading the JSONL) and
assert the emitSchema-shaped payload. Always test `stopSubscribe` actually stops the source.

## Pure logic

Extract math/fitting/planning into pure functions in their own module and unit-test them with
worked examples the user can verify by hand. This is where most of your test count should live.
