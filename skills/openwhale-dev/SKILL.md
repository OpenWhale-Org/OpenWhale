---
name: openwhale-dev
description: Write runnable OpenWhale components — strategies, monitors, executors, account implementations, venue adapters, full plugins, and kind extensions. Use whenever the user wants to build, extend, or debug anything that plugs into the OpenWhale trading framework.
---

# OpenWhale Plugin Development

> **Calibrated against `@openwhaleorg/core` v0.1.1 on main (re-verified 2026-08-25).** If the installed core is newer,
> verify signatures against the framework source before trusting a template verbatim.

OpenWhale is an AI-native trading framework: **Monitor → Trigger → Strategy → Queue → Executor**.
You are writing a **plugin package** — an npm package whose default export is a `definePlugin({...})`
manifest. The user installs it from the Dashboard (Plugins page → local path or npm spec) into a
running Gateway; no framework code is ever modified.

## The 8 concepts (fixed vocabulary — never invent others)

| Concept | One-liner | You write |
|---|---|---|
| **Credential** | A key: `type` + user-chosen `name` + encrypted data. A type is a key FAMILY — a CEX issues its own (`'binance'`), on-chain one wallet key (`'web3/evm'`) opens many venues | a `credentialTypes` entry (Zod schema + `test`, optional `logo`/`managed`) |
| **Kind** | Domain vocabulary, namespaced (`'exchange/perp'`) | nothing to register — a kind exists iff a cell/implementation claims it |
| **Adapter** | The `(kind, venue)` cell: factory `create(data?)` + the credential types it accepts | an `adapters` entry |
| **Account** | First-class entity: implementation × credential × declared params | an `@OwAccount` class (read view; may declare `paramsSchema` and a declarative detail panel) |
| **Monitor** | contract / implementation / instance, data keyed by `(contractName, key)` | an `@OwMonitor` class |
| **Executor** | Singleton service with named credential slots | an `@OwExecutor` class |
| **Strategy** | Declarations + params + `triggers()` + `evaluate()` | an `@OwStrategy` class |
| **Plugin** | Pure manifest — decorators attach metadata, arrays register | `definePlugin({...})` |

Core rule everything hangs off: the **venue × kind matrix**. kind = domain column, venue = the place
you trade/read (`'binance'`, `'boros'`, `'evm'`). A cell `(kind, venue)` names the credential types that
open it (`credentialTypes`, default `[venue]` — the CEX case). Generic implementations claim a column,
specializations claim a cell, specialization wins. `type` is the deprecated spelling of `venue`.

## What are you being asked to write?

- **A trading strategy** → `references/strategy.md`. Usually also needs an executor if the action
  isn't covered by the shared `exchange/perp-trading` / `exchange/spot-trading` executors.
- **A data feed / market watcher** → `references/monitor.md`.
- **An order-execution service** → `references/executor.md`.
- **Support for a new exchange/venue** → `references/plugin.md` §Venue plugin (credential type +
  adapter cells; optionally a specialized Account).
- **A new domain (new kind)** → `references/plugin.md` §New kind (AdapterKindMap merge + mock cell +
  generic Account).
- **Packaging / install / project scaffold** → `references/plugin.md` §Packaging.
- **An operator utility for the Scripts page** → a `ScriptDefinition` in the plugin's `scripts: []`
  array — see `references/plugin.md` §Scripts. `definePlugin` does NOT accept `scripts`; a plugin
  that ships them must use the raw `PluginFactory` form.
- **Tests** → `references/testing.md`. Always write them; every template there runs offline.

Working code to copy from: `packages/strategies/examples` (`@openwhaleorg/examples`) — five
venue-agnostic strategies (momentum breakout, mean reversion, scheduled accumulation, an
LLM-driven analyst, copy-trading) over a tested `indicators.ts`. Read the one closest to the ask
before writing: they show the account-slot / `accountVenue` idiom, `store`-based idempotency, and
the discipline that risk limits live in code even when a model produces the signal.

## Since 2026-08-06 (newest first)

- **`venue` replaces `type` on cells and account implementations** — `{ kind, venue, credentialTypes?,
  create }`. On-chain venues list a shared key family (`credentialTypes: ['web3/evm']`) instead of a
  venue-issued key; a cell without `credentialTypes` accepts `[venue]`. (`references/plugin.md`)
- **Account params + declarative detail panels** — `@OwAccount({ paramsSchema, sections })`: params
  render on the account form and reach the constructor as a third argument; `sections` describes the
  detail tables/key-values the Dashboard draws from the class's own reader methods. (`references/plugin.md`)
- **`paramsIllustrations`** on a strategy — sandboxed HTML iframes rendered inside the param form, fed
  the live field values via postMessage. (`references/strategy.md`)
- **Brand marks** — `logo` / `icon` / `readme` on the manifest; `logo` / `icon` / `description` /
  `managed` on a credential type (`managed` hides it from the add-credential picker: created by a
  script, e.g. a venue's delegated agent key). (`references/plugin.md`)
- **Scripts stream and attach** — `ctx.emit?.(line)` feeds progress to the page while a run lasts;
  `ScriptResult.files` offers downloads (inline content, report-sized). (`references/plugin.md`)
- **`@openwhaleorg/web3`** — kind `'web3/chain'` (EVM read/sign session, `ChainAccount` wallet view),
  credential types `'web3/evm'` (wallet key) and `'web3/rpc'`. On-chain venue packages depend on it for
  the wallet key family and never ship their own chain client.

## Since v0.1.0

- **Optional executor credential slots** — `{ label, type, raw: true, optional: true }`: activation
  proceeds with the slot unbound; read with `this.rawIfBound(label)` (undefined = unbound) and
  return a clear failed result instead of throwing. For side-channel executors (notifiers) gated
  by a strategy toggle. (`references/executor.md`)
- **Automatic PnL attribution** — record `{ orderId, symbol }` on the same object anywhere in the
  execution result's `data` (depth ≤ 6) and the framework claims the order for the instance; venue
  fills and funding then attribute automatically. Follow the convention for EVERY placed order,
  including resting/protective orders. (`references/executor.md`)
- **Dynamic monitor sources** — a live strategy may call
  `this.addMonitorSource(label, key, { trigger? })` to start collecting a key discovered at
  runtime. No-op (returns false) where unsupported. (`references/strategy.md`)
- **`table` and `scatter` plot kinds** — monitors may declare sortable table panels via
  `{ kind: 'table', columns: [...] }`, and correlation panels (points + fitted trend line with a
  confidence band) via `{ kind: 'scatter' }`. (`references/monitor.md`)

Read the reference file for each component you touch BEFORE writing code. The templates there are
verified against the framework source — copy their shape exactly.

## Hard rules (violating any of these breaks at load or runtime)

1. **TS5 standard decorators** — never set `experimentalDecorators`. Build with `tsc` targeting
   ES2022+. Vitest configs need `esbuild: { target: 'es2022' }` or decorated classes fail to parse.
2. **Decorators only attach metadata.** Registration happens exclusively through the
   `definePlugin` arrays. Importing a class registers nothing.
3. **IDs are short and get plugin-qualified at load.** Write `id: 'my-monitor'`; the runtime turns
   it into `'{pluginName}/my-monitor'`. Reference OTHER plugins' components by their qualified id
   (`'exchange/funding-rates'`); your own by short name.
4. **Strategies are structurally read-only.** They receive Account read views (no write methods
   exist on the object). All order flow travels `instruction → queue → executor`. Never try to
   place an order from a strategy.
5. **No venue parameter when an account binding implies it.** The runtime injects
   `AccountSlotMeta` before `triggers()`; derive the venue with `this.accountVenue('slotLabel')` —
   the account's cell venue (equal to the credential type only for venue-issued keys).
6. **Monitor keys are clean**: no credential or instance identifiers inside a key. Data lives in
   `dataDir/monitors/{contractName}/{key}.jsonl`, shared by all implementations of a contract.
7. **Params are read once, at activation** — triggers, subscriptions and executor slots all derive
   from them there. So editing a RUNNING strategy instance restarts it: `updateInstance(id, patch,
   { restart: true })` (gateway: `PATCH /api/instances/:id?restart=1`) rebuilds it from the new
   params, and rolls back to the previous ones if they fail to activate. Without `restart` the edit
   is refused while active. Monitor instance params still freeze. Tuning params go in Zod schemas
   with `.meta()` so the Dashboard renders forms; never in plugin config.
8. **Instructions are serializable JSON** referencing executor slot labels — never object refs.
9. **All fields of `tunableParamsSchema` must have `.default()`**; `baseParamsSchema` holds the
   required fields. `.meta({ displayName, description, placeholder })` drives the form UI.
10. **ESM only.** `"type": "module"` in package.json, `.js` extensions on relative imports.

## Workflow

1. Scaffold the package (see `references/plugin.md` §Packaging — package.json, tsconfig, vitest).
2. Write component classes with their `@Ow*` decorators.
3. List them in `definePlugin({...})` — the default export of the entry module.
4. `pnpm build && pnpm test` — both must be green. Fix decorator/ESM issues per rule 1/10.
5. Install: Dashboard → Plugins → Install, enter the package's **absolute path** (npm symlinks it;
   rebuild + reinstall picks up changes), or publish and enter the npm spec.
   API equivalent: `POST /api/plugins {"source":"npm","package":"/abs/path/or/spec"}`.
6. Wire up in the Dashboard: create Credentials → Accounts → Monitor instances (credential-less
   monitors auto-create a default instance) → Strategy instance (one form binds params + slots).

## Debugging a running plugin

- Executor logs: `GET /api/executor/{qualified-id}/logs?n=200`; execution records:
  `GET /api/executor/{qualified-id}/records` and per-instance `GET /api/instances/{id}/executions`.
- Monitor data: Dashboard → Monitor page (BOARDS render `plots()`), or read
  `~/.openwhale/monitors/{contract}/{key}.jsonl` directly.
- Strategy state: the KV store is the `strategy_store` table in `~/.openwhale/openwhale.db`.
- Reinstall cycle: `DELETE /api/plugins/{name}` then re-POST. A restart of the gateway reloads
  all installed plugins.
