# From a strategy idea to a spec that runs first time

A strategy described in two sentences has a dozen decisions hiding in it, and every one the
author leaves unsaid is one you will guess. A guess that is wrong costs a rebuild; a guess that is
silently wrong costs money. So the work of writing a strategy starts before any code: **interview
the user until nothing is assumed, write the answers down as a spec, get the spec confirmed, then
write the code from the spec.** Code written from a confirmed spec runs the first time far more
often than code written from a chat.

This file is the interview. Work it as a **design tree**: each decision unlocks the ones below it.
Ask in **rounds** — every question whose prerequisites are settled, numbered, each with your
recommended answer — then wait. A question that depends on an answer still open this round
belongs to the next round.

Facts are your job, decisions are the user's. If a question needs a fact from the framework or the
venue (does this contract exist, which kinds does this venue fill, what does this executor's
`placeOrder` accept), look it up — `packages/framework`, `packages/venues`, the installed plugin's
source — and never ask the user for it. Put every *decision* to them, with a recommendation.

Format each question so:

```
❓ **Q3** — **Fill handling**: The strategy rests orders it expects NOT to fill. When one fills
anyway, what happens? (a) close at market immediately (b) hold and manage as a position
(c) pause quoting until flat, then resume

➡️ (c). A market close after an unexpected fill sells into the move that filled you; holding
without a plan is an unmanaged position. Pausing keeps risk bounded and makes the state visible.
```

## Round 1 — what the strategy IS

Settle these before anything else; every later question hangs off them.

1. **The edge, in one sentence.** What inefficiency is being harvested, and why does it exist?
   A strategy that cannot say this cannot be tested for whether it is working.
2. **Venues and kinds.** Which venue(s), and for each: does it trade perps (`exchange/perp`),
   spot (`exchange/spot`), on-chain rates (`pendle/rates`), something else? *Fact to look up:*
   which cells the venue's plugin fills, and which credential types open them.
3. **Accounts.** One account or several? Same venue or different? Each becomes an account slot
   with a label and a read-view class. *Never* a venue param — the venue derives from the slot.
4. **Data.** What must the strategy see to decide? Map each need to a monitor contract —
   `exchange/funding-rates`, `exchange/klines`, `exchange/ticker`, a venue's own, or one you will
   write. *Fact to look up:* the contract's key shape and emit schema.
5. **Actions.** What does it do to the venue? Map each to an executor action — the shared
   `exchange/perp-trading` / `exchange/spot-trading`, a venue's own, or one you will write.
   *Fact to look up:* the executor's action names and param schemas.

## Round 2 — when it runs, and what it does each time

6. **Trigger.** On every monitor push, on a schedule (cron + timezone), or both? A cron strategy
   reads the latest data; a monitor-triggered one reacts to each record. Cycles built around a
   fixed instant (a settlement, an expiry) are cron with a lead time.
7. **Gates, in order.** List every condition that must hold before an instruction is emitted, in
   the order they are checked. Each gate becomes a `this.trace(...)` step and a test. Common gates
   the user forgets to mention: minimum data available, signal above threshold, no position
   already open, exposure below cap, not already acted this period.
8. **Sizing.** Fixed notional, percent of equity, percent of margin, scaled by signal strength?
   What is the cap, and what is it measured against (total equity, available, margin)? Where a
   baseline snapshot excludes pre-existing positions, say so.
9. **Idempotency.** What makes two evaluations of the same moment emit once? A key in
   `this.store` — of what? (`acted:{venue}:{timestamp}` is the usual shape.)
10. **The instruction(s).** Which executor label, which action, which params — written out. One
    instruction or several per evaluation? Do they run in parallel or does one depend on another?

## Round 3 — what can go wrong

The round users skip, and the round that decides whether the strategy survives its first week.

11. **Unexpected fills.** For resting orders: what happens when one fills? For market orders:
    what happens when the fill is partial, or worse than expected?
12. **Positions across restarts.** The gateway restarts mid-cycle. What state must be recovered,
    from where — the venue (positions, open orders) or `this.store`? A strategy that only trusts
    its store will double a position it forgot; one that only trusts the venue cannot tell its own
    position from a manual trade on the same account.
13. **Exit.** How does a position close — time, target, stop, opposite signal? Who executes the
    exit: the same strategy on a later trigger, or the executor within one long cycle?
14. **Stops.** Does the venue support the stop type you want? *Fact to look up.* If not, the
    strategy monitors and fires the stop itself, which means it needs a trigger frequent enough to
    catch it.
15. **Dry run.** What does `dryRun` mean here — identical decisions with `simulate` instead of
    `placeOrder`, and what does the simulation report? Default on.
16. **Failure of an action.** An instruction fails (rejected, timeout). Retry? Skip the period?
    Halt the instance? Where does the operator see it?

## Round 4 — parameters and operation

17. **Params, sorted.** Every number the strategy uses, sorted into `base` (required, no default —
    capital, market, account-shaped things) and `tunable` (defaulted — thresholds, sizes, timings).
    For each: unit, range, what a wrong value does. These become Zod schemas with `.meta()`.
18. **Symbol params.** Any param that is a market symbol gets `.meta({ catalogue: { source:
    'market', kind } })` so the form offers a picker; any that must exist on the venue gets
    `availability` so a typo is refused at save.
19. **What the operator sees.** Which trace steps, which numbers in the run's data, which
    monitor plots. A strategy that emits nothing for a week should be able to say why.

## The spec

When the frontier is empty, write the spec from the answers — no new interviewing — and ask the
user to confirm it before writing code. Use this shape:

```markdown
# <Strategy name>

## Edge
One paragraph: the inefficiency, why it exists, what closes it.

## Components
| Role | Label | Registry id / class | Notes |
|---|---|---|---|
| account | main | PerpAccount on `<kind>` | venue derives from binding |
| monitor | rates | `exchange/funding-rates` | key = venue |
| executor | trade | `exchange/perp-trading` | actions: placeOrder, simulate |

## Trigger
cron `0 * * * *` UTC / every push of `rates` — and why.

## Evaluate, in order
1. gate — `trace('name', {…})` — refuse when …
2. …
N. emit `instruction('trade', 'placeOrder', {…}, ['main'])`

## Sizing
Formula, cap, what it is measured against.

## Idempotency
Store key and lifetime.

## Failure handling
| Situation | Behaviour |
|---|---|
| unexpected fill | … |
| restart mid-cycle | … |
| action rejected | … |

## Params
| Name | Group | Type | Default | Unit | Meaning |
|---|---|---|---|---|---|

## Out of scope
What this version deliberately does not do.

## Tests
Happy path with worked numbers; each gate; dryRun/live; idempotency; the failure rows above.
```

Then write the code from the spec — `references/strategy.md` for the class, `references/executor.md`
if an action is new, `references/testing.md` for the tests, which are the spec's last section made
executable. When the code and the spec disagree, the spec is wrong or the code is: fix one, never
let them drift.
