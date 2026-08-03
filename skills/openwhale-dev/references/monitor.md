# Writing a Monitor

A monitor has three layers: **contract** (name + keySchema + emitSchema — what strategies see),
**implementation** (your class), **instance** (user-created runner, binds a credential, holds
frozen params). Data is stored per `(contractName, key)` as JSONL; all implementations of one
contract share the same files.

## Complete template

```ts
import { z } from 'zod'
import { BaseMonitor, MonitorMode, OwMonitor, createLogger } from '@openwhaleorg/core'
import type { MonitorContext, MonitorPlotDef } from '@openwhaleorg/core'

const log = createLogger('PriceWatchMonitor')

export interface PriceWatchOptions {
  intervalMs?: number
}

const emitSchema = z.object({
  symbol: z.string(),
  price: z.number(),
  timestamp: z.number(),
})
export type PriceTick = z.infer<typeof emitSchema>

@OwMonitor({
  id: 'price-watch',                       // short — becomes '{plugin}/price-watch'
  name: 'Price Watch',
  description: 'Polls a symbol price. Key: "venue:symbol".',
  // credential: { type: 'my-venue', level: 'required' },   // omit = credential-less
  params: z.object({                       // instance tuning params — frozen while active
    intervalMs: z.number().int().min(500).default(5_000)
      .meta({ displayName: 'Poll Interval (ms)' }),
  }),
})
export class PriceWatchMonitor extends BaseMonitor<string, PriceTick> {
  readonly mode = MonitorMode.Subscribe    // subscribe-only is the ONLY supported mode

  private readonly options: PriceWatchOptions
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>()

  constructor(ctx?: MonitorContext, options: PriceWatchOptions = {}) {
    super(ctx?.dataDir !== undefined ? { dataDir: ctx.dataDir } : undefined)
    // Instance params (validated + defaulted by the runtime) arrive in ctx.params.
    this.options = { ...(ctx?.params as PriceWatchOptions | undefined), ...options }
  }

  get monitorName(): string { return 'price-watch' }

  override get emitSchema() { return emitSchema }

  override get keySchema() {
    return z.object({
      venue: z.string().meta({ displayName: 'Venue' }),
      symbol: z.string().meta({ displayName: 'Symbol', placeholder: 'BTC/USDT:USDT' }),
    })
  }

  protected startSubscribe(key: string): void {
    const [venue, symbol] = key.split(':', 2)
    log.info({ key }, 'Starting')
    const timer = setInterval(() => {
      void (async () => {
        const price = await fetchPriceSomehow(venue!, symbol!)
        await this.push(key, { symbol: symbol!, price, timestamp: Date.now() })
      })().catch(err => log.warn({ key, err }, 'poll failed'))
    }, this.options.intervalMs ?? 5_000)
    this.timers.set(key, timer)
  }

  protected stopSubscribe(key: string): void {
    clearInterval(this.timers.get(key))
    this.timers.delete(key)
  }
}
declare function fetchPriceSomehow(venue: string, symbol: string): Promise<number>
```

## Essentials

- `this.push(key, data)` — validate-and-append one record; it lands in
  `dataDir/monitors/{contract}/{key}.jsonl` and fires subscribed triggers.
- `startSubscribe(key)` / `stopSubscribe(key)` — called by the runtime as strategy instances
  subscribe/unsubscribe. Manage your own connections per key; ALWAYS clean up in stop.
- Long-lived streams: keep an `AbortController` per key, reconnect-with-backoff in a loop, and
  dedupe replayed events (see `packages/hyperliquid/src/monitor.ts` for the canonical pattern).
- Keys are plain strings. When keySchema has multiple fields they are joined in field order with
  `:`. Keep keys clean — no credential/instance identifiers (hard rule 6).
- Credential-less monitors get a **default instance auto-created and activated** on install.
  Credentialed ones wait for the user to create an instance and bind a credential.
- **Single-active**: per dispatch domain only one instance runs at a time; each key has exactly
  one producer.

## Symbol fields: offer a picker, don't make users type ccxt symbols

A field whose value is a venue symbol should carry a `catalogue` marker in its `.meta()`. The
Dashboard then renders a searchable picker populated from that venue's live market list instead of
a bare text box:

```ts
symbol: z.string().min(1).meta({
  displayName: 'Symbol',
  placeholder: 'BTC/USDT:USDT',
  catalogue: { source: 'market', venueField: 'venue', kind: 'exchange/perp', marketType: 'swap' },
})
```

- `venueField` names the **sibling field** holding the venue. Omit it on STRATEGY params, where
  there is no venue field at all (rule 5) — the instance form supplies the bound account's venue.
- `marketType` narrows the list (`'swap'` for perps, `'spot'` for spot).
- The field stays a plain string and free text always submits: an unlisted symbol, a venue with no
  catalogue, or an unreachable gateway all fall back to typing. The picker is an aid, not a
  constraint — never validate against the catalogue.
- Nothing to implement per monitor: the picker is served by `GET /api/markets?venue&kind`, which
  resolves the venue's KEYLESS session and duck-types `fetchMarkets()`. Any ccxt-backed venue has
  it for free via `CcxtAdapter`; a hand-rolled adapter that omits it just returns 501.

## Historical backfill (optional — implement it whenever the data is archival)

If the venue can serve the data you'd otherwise only observe live (klines, funding history,
anything with a "give me the last N" endpoint), implement `backfill()`. The framework calls it on
a key's FIRST subscribe, before `startSubscribe`, so consumers get warm history instead of an
empty file:

```ts
protected override async backfill(
  key: string,
  since: number | undefined,     // ts of the newest stored record — the incremental watermark
  signal: AbortSignal,           // aborts if the key is unsubscribed mid-fetch
): Promise<Array<{ ts: number; data: PriceTick }>> {
  const [venue, symbol] = key.split(':', 2)
  const bars = since === undefined ? 500 : gapBars(since)   // only fetch the gap on a warm key
  const session = await this.adapters.resolve<PerpExchangeAdapter>('exchange/perp', venue!)
  const rows = await session.fetchOHLCV(symbol!, '1h', bars)
  return rows.map(r => ({ ts: r.timestamp + HOUR, data: toTick(r) }))   // ts = when it became TRUE
}
```

Contract:
- Return records **ascending by ts**, each `ts > since`. The base sorts and re-filters anyway, but
  a source that can't honour it is usually a sign the watermark is being ignored.
- Each record's `ts` is **when the value became true** (a candle's close time), not fetch time.
  This is what keeps the file ordered against the live emits that follow.
- History is persisted **without dispatching triggers** — a strategy must never fire on a stale
  signal it could not have traded.
- Throwing is non-fatal: it's logged and live collection starts anyway. Never let a dead archive
  endpoint take the live feed down with it.
- Expose the depth as an instance param (`backfillBars`, `backfillPoints`, …) with `0` meaning off.
- If your live loop skips the first observation to avoid replaying (the "adopt the current bar as
  baseline" trick), seed its watermark from `getReader().readLatest(key)` instead — otherwise the
  bar that closes between backfill and live start is lost.
- Derived signals reconstruct too, but only **walk-forward**: fit each historical point on bars
  strictly before it. A fit that includes the point is look-ahead and makes the backfilled curve
  disagree with the live one it's supposed to continue.

`supportsBackfill` is derived from whether the hook exists and surfaces on the monitor definition
and Dashboard.

## Specializing another plugin's contract

Same contract name + subclass + NARROWED keySchema (same field names/order, values only):

```ts
import { FundingRateMonitor } from '@openwhaleorg/exchange'

@OwMonitor({
  id: 'cmc-funding-rates',
  contract: 'exchange/funding-rates',        // serve ANOTHER plugin's contract
  credential: { type: 'cmc', level: 'required' },
})
export class CmcFundingRateMonitor extends FundingRateMonitor {
  override get keySchema() {
    return z.object({ venue: z.literal('cmc') })   // claim venue 'cmc' — parent stays fallback
  }
}
```

Dispatch walks leaf-first: the most specific implementation whose keySchema accepts the concrete
key wins; the generic parent is the natural fallback.

## Dashboard boards: `plots()`

Declare panels; `extract` runs SERVER-side over the key's recent records, the frontend renders
the returned series with a shared chart component. One unit per panel — never dual-axis.

```ts
override plots(): MonitorPlotDef[] {
  return [{
    id: 'price', title: 'Price', kind: 'line', unit: 'USD',
    extract: (records) => [{
      label: 'last',
      points: records.map(r => ({ x: r.ts, y: (r.data as PriceTick).price })),
    }],
  }, {
    id: 'candles', title: 'Candles', kind: 'candles', unit: 'USD',
    extract: (records) => [{
      label: 'ohlc',
      candles: buildCandles(records),   // [{ x, o, h, l, c, v }]
    }],
  }]
}
```

`kind: 'line' | 'bar' | 'candles' | 'table'`; `xKind: 'value'` + `xUnit` for non-time x-axes
(e.g. a depth curve over basis points). A `table` panel declares `columns: [{ key, label }]` and
its `extract` returns row objects keyed by column — headers are click-to-sort in the dashboard
(rows missing a value sink to the bottom).

### Panel pickers

A panel may derive selectable entries from its own record window with
`options(records) → [{ value, label, default? }]`. The dashboard renders the control and passes
the choice back to `extract`. Two flavours, chosen by whether the entries can coexist on the axis:

| | `multi` | Control | `extract` receives |
|---|---|---|---|
| Alternative **views** — which captured session to display | omit | dropdown | `option?: string`, first option is the default |
| Coexisting **series** — which tokens to overlay | `multi: true` | checkbox list | `option?: string[]`, the `default: true` entries are pre-selected |

```ts
{
  id: 'fitted-curve', title: 'Fitted Curve', kind: 'line', unit: '%',
  multi: true,
  options: (records) => [
    { value: '__global__', label: `global (${records.length})`, default: true },
    ...topTokens(records).map((t, i) => ({ value: t.symbol, label: t.symbol, ...(i < 3 ? { default: true } : {}) })),
  ],
  extract: (records, option) => {                 // option: string[] because multi is true
    const picked = new Set(option ?? [])
    return seriesFor(records, picked)
  },
}
```

The type is a discriminated union on `multi`, so declaring it flips `extract`'s argument type —
single-select panels keep the plain string and need no changes.

The runtime resolves every request against the CURRENT option list before calling `extract`:
stale values (a session that scrolled out of the window) are dropped, and an empty result falls
back to the `default` entries. So `extract` never sees an unknown or empty selection — index into
your data without defensive checks.
