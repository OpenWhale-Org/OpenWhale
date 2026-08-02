---
name: openwhale-dev
description: Write runnable OpenWhale components — strategies, monitors, executors, account implementations, venue adapters, full plugins, and kind extensions. Use whenever the user wants to build, extend, or debug anything that plugs into the OpenWhale trading framework.
---

# OpenWhale Plugin Development

OpenWhale is an AI-native trading framework: **Monitor → Trigger → Strategy → Queue → Executor**.
You are writing a **plugin package** — an npm package whose default export is a `definePlugin({...})`
manifest. The user installs it from the Dashboard (Plugins page → local path or npm spec) into a
running Gateway; no framework code is ever modified.

## The 8 concepts (fixed vocabulary — never invent others)

| Concept | One-liner | You write |
|---|---|---|
| **Credential** | A key: `type` + user-chosen `name` + encrypted data | a `credentialTypes` entry (Zod schema + `test`) |
| **Kind** | Domain vocabulary, namespaced (`'exchange/perp'`) | nothing to register — a kind exists iff a cell/implementation claims it |
| **Adapter** | The `(kind, type)` cell: factory `create(data?)` | an `adapters` entry |
| **Account** | First-class entity: implementation × credential | an `@OwAccount` class (read view) |
| **Monitor** | contract / implementation / instance, data keyed by `(contractName, key)` | an `@OwMonitor` class |
| **Executor** | Singleton service with named credential slots | an `@OwExecutor` class |
| **Strategy** | Declarations + params + `triggers()` + `evaluate()` | an `@OwStrategy` class |
| **Plugin** | Pure manifest — decorators attach metadata, arrays register | `definePlugin({...})` |

Core rule everything hangs off: the **type × kind matrix**. kind = domain column, type = venue/credential
row. Generic implementations claim a column, specializations claim a cell, specialization wins.

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
- **Tests** → `references/testing.md`. Always write them; every template there runs offline.

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
   `AccountSlotMeta` before `triggers()`; derive the venue with `this.accountVenue('slotLabel')`.
6. **Monitor keys are clean**: no credential or instance identifiers inside a key. Data lives in
   `dataDir/monitors/{contractName}/{key}.jsonl`, shared by all implementations of a contract.
7. **Instance params freeze on activation** (both monitor and strategy instances). Tuning params
   go in Zod schemas with `.meta()` so the Dashboard renders forms; never in plugin config.
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
