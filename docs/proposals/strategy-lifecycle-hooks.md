# Strategy lifecycle hooks

Status: proposal. Motivated by the CrossEx pair strategies, which rest post-only quotes and
cannot cancel them when the instance stops: the runtime calls nothing on the strategy at
deactivation, so the quote survives the instance that placed it.

## What exists

A strategy is told about the world through setters (`setParams`, `setReaders`, `setStore`, …)
and hears back through one hook, `onExecutionResult`. It has no moment of its own at the start
and none at the end. Teardown (`releaseInstance`) unregisters triggers, drops executor slots and
closes sessions; nothing between those steps is the strategy's.

## Hooks

Both optional on `IStrategy`, no-op on `BaseStrategy`.

```ts
interface LifecycleContext {
  instanceId: string
  reason: 'activate' | 'boot' | 'restart' | 'rollback' | 'stop' | 'delete' | 'shutdown'
}

onActivate?(ctx: LifecycleContext): Promise<ExecutionInstruction[] | void>
onDeactivate?(ctx: LifecycleContext): Promise<ExecutionInstruction[] | void>
```

Returned instructions are **fired inline and awaited**, not queued: what a hook emits must be
finished before the lifecycle step completes — leverage set before the first clip, quotes
cancelled before the slots that could cancel them are gone. They pass through the same label
resolution and dry-run gate as a run's instructions; a dry-run instance records them as
`dry-run` like everything else.

### `onActivate`

Called once per activation, after every setter and after triggers are registered, before the
first trigger may fire. This is where a baseline snapshot, a leftover-quote check, or a
`setLeverage` belongs today they are done on the first evaluation, guarded by a store flag,
which means the first quote pair is spent on housekeeping.

A throw fails the activation. Under `restart` the existing rollback applies: the previous
configuration is reactivated, with `reason: 'rollback'`.

### `onDeactivate`

Called before anything is torn down, in this order:

```
deactivate(id)
  1. triggerManager.suspend(id)      no new run may start
  2. triggerManager.drain(id)        a run in flight finishes (bounded: runTimeoutMs)
  3. strategy.onDeactivate(ctx)      returned instructions fired inline, awaited
  4. unregisterInstance              cron tasks, subscriptions
  5. removeMaterialized              executor slots
  6. close sessions                  as today
```

Steps 1–2 exist so the hook never runs concurrently with `evaluate()`; step 3 runs while executor
slots are still materialized, which is the whole point.

Failure never blocks a stop. A hook that throws, or instructions that fail, are logged and the
teardown continues: an instance that cannot be deactivated would resume trading on the next boot.
The budget is `quiesceTimeoutMs` (runtime option, default 15 s); `shutdown` applies one budget
across all instances.

### Reasons

| reason | when |
|---|---|
| `activate` | operator activates a stopped instance |
| `boot` | runtime start restores persisted active instances |
| `restart` | `updateInstance(…, { restart: true })` — deactivate then activate the new object |
| `rollback` | the restart's activation failed; the previous configuration comes back |
| `stop` | operator deactivates |
| `delete` | `deleteInstance` — a stop, then the row is removed |
| `shutdown` | `runtime.stop()` |

A strategy that treats `restart` like `stop` (cancels its quotes) is correct; one that wants to
keep quotes across a restart may read the reason and decline — the store survives.

## Traces

Hook runs are recorded as runs with `triggerId: 'lifecycle:<reason>'`, so the instance board
shows what deactivation did next to what evaluation did. `this.trace()` works inside them.

## What this does not add

- No `onPause`: pausing is a strategy's own state in its store, and the reference behaviour
  (five failures → stop emitting) needs no runtime concept.
- No executor or monitor hooks: `removeMaterialized` and `stopSubscribe` already are those.
- No `onBeforeRun`/`onAfterRun`: `run()` is the strategy's own method to override.

## Changes, by file

| File | Change |
|---|---|
| `types/strategy.ts` | `LifecycleContext`; the two optional methods on `IStrategy` |
| `strategy/BaseStrategy.ts` | no-op defaults; `runLifecycle(reason, fn)` reusing the trace scope |
| `trigger/TriggerManager.ts` | `suspend(id)`, `drain(id)`, `fireInline(id, instructions)` — label resolution and the dry-run gate factored out of `checkAndFire` |
| `runtime/OpenWhaleRuntime.ts` | call sites in `activateInstance`, `releaseInstance` (with reason), `stop()`; `quiesceTimeoutMs` option |
| skill `references/strategy.md` | the two hooks, when to use which, the reason table |

Compatibility: additive. A strategy without the hooks behaves exactly as today.
