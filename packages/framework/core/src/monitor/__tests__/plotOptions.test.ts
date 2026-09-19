import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { OpenWhaleRuntime } from '../../runtime/OpenWhaleRuntime.js'
import { BaseMonitor, MonitorMode } from '../BaseMonitor.js'
import type { CredentialStore, MonitorPlotDef } from '../../index.js'
import { MonitorDataReaderImpl } from '../MonitorDataReader.js'

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'none', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

interface Sample extends Record<string, unknown> { token: string; value: number }

/**
 * One panel of each flavour over the same records: a single-select "which
 * capture" picker and a multi-select "which series" filter.
 */
class PanelMonitor extends BaseMonitor<string, Sample> {
  override readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'panels' }
  protected override startSubscribe(): void {}
  protected override stopSubscribe(): void {}

  /** Records the arguments extract actually received, for assertions. */
  lastMultiOption: string[] | undefined
  lastSingleOption: string | undefined

  override plots(): MonitorPlotDef<Sample>[] {
    const tokens = (records: Array<{ data: Sample }>) => [...new Set(records.map(r => r.data.token))]
    return [
      {
        id: 'single',
        title: 'One capture',
        kind: 'line',
        options: (records) => tokens(records).map(t => ({ value: t, label: t })),
        extract: (records, option) => {
          this.lastSingleOption = option
          return [{ label: option ?? 'none', points: records.filter(r => r.data.token === option).map(r => ({ x: r.ts, y: r.data.value })) }]
        },
      },
      {
        id: 'multi',
        title: 'Many tokens',
        kind: 'line',
        multi: true,
        options: (records) => tokens(records).map((t, i) => ({
          value: t, label: t, ...(i < 2 ? { default: true } : {}),
        })),
        extract: (records, option) => {
          this.lastMultiOption = option
          const picked = new Set(option ?? [])
          return tokens(records).filter(t => picked.has(t)).map(t => ({
            label: t, points: records.filter(r => r.data.token === t).map(r => ({ x: r.ts, y: r.data.value })),
          }))
        },
      },
    ]
  }
}

let dataDir: string
let runtime: OpenWhaleRuntime
let monitor: PanelMonitor

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-plot-options-'))
  runtime = new OpenWhaleRuntime({ dataDir, credentialStore })
  monitor = new PanelMonitor({ dataDir })
  runtime.registerMonitor(
    { id: 'panels', name: 'Panels', source: 'builtin', createdAt: '', updatedAt: '' },
    monitor,
  )
  // Three tokens, descending sample counts: A×3, B×2, C×1
  const rows: Array<{ ts: number; data: Sample }> = [
    ...Array.from({ length: 3 }, (_, i) => ({ ts: 1_000 + i, data: { token: 'A', value: i } })),
    ...Array.from({ length: 2 }, (_, i) => ({ ts: 2_000 + i, data: { token: 'B', value: i } })),
    { ts: 3_000, data: { token: 'C', value: 9 } },
  ]
  await (monitor as unknown as { appendHistorical(k: string, r: typeof rows): Promise<void> })
    .appendHistorical('k', rows)
})

function series(plotId: string, option?: string | string[]) {
  return runtime.monitorPlotSeries('panels', plotId, 'k', 500, option)
}

describe('panel metadata', () => {
  it('advertises which panels are multi-select', () => {
    const plots = runtime.monitorPlots('panels')
    expect(plots.find(p => p.id === 'multi')!.multi).toBe(true)
    expect(plots.find(p => p.id === 'single')!.multi).toBeUndefined()
  })
})

describe('single-select resolution', () => {
  it('defaults to the first option', async () => {
    const res = await series('single')
    expect(res.option).toBe('A')
    expect(monitor.lastSingleOption).toBe('A')
  })

  it('honours a valid pick', async () => {
    expect((await series('single', 'B')).option).toBe('B')
  })

  it('falls back when the pick has scrolled out of the window', async () => {
    expect((await series('single', 'GONE')).option).toBe('A')
  })

  it('takes the first entry when handed an array', async () => {
    expect((await series('single', ['B', 'C'])).option).toBe('B')
  })
})

describe('multi-select resolution', () => {
  it('defaults to the options flagged default, not just the first', async () => {
    const res = await series('multi')
    expect(res.option).toEqual(['A', 'B'])
    expect(monitor.lastMultiOption).toEqual(['A', 'B'])
    expect(res.series.map(s => s.label)).toEqual(['A', 'B'])
  })

  it('honours an explicit multi pick', async () => {
    const res = await series('multi', ['A', 'C'])
    expect(res.option).toEqual(['A', 'C'])
    expect(res.series.map(s => s.label)).toEqual(['A', 'C'])
  })

  it('drops stale values but keeps the surviving ones', async () => {
    expect((await series('multi', ['C', 'GONE'])).option).toEqual(['C'])
  })

  it('an all-stale selection falls back to the defaults rather than drawing nothing', async () => {
    const res = await series('multi', ['GONE', 'ALSO_GONE'])
    expect(res.option).toEqual(['A', 'B'])
    expect(res.series.length).toBeGreaterThan(0)
  })

  it('accepts a bare string (one param on the query string)', async () => {
    expect((await series('multi', 'C')).option).toEqual(['C'])
  })

  it('never hands extract an empty selection', async () => {
    await series('multi', [])
    expect(monitor.lastMultiOption?.length).toBeGreaterThan(0)
  })

  it('returns the live option list so the picker can render it', async () => {
    const res = await series('multi')
    expect(res.options?.map(o => o.value)).toEqual(['A', 'B', 'C'])
    expect(res.options?.filter(o => o.default).map(o => o.value)).toEqual(['A', 'B'])
  })
})

/**
 * A store too big to slurp answers "all history" with a time-even sample, and
 * captures that share an instant are exactly what such a sample cannot show.
 * The settlement-session board is made of these: a dozen contracts settle at
 * the same minute, and the picker offered one of them — a different one each
 * hour, whichever the sample happened to land on.
 */
describe('a picker over a store too big to slurp', () => {
  interface Capture extends Record<string, unknown> { token: string }

  /** Twelve settlements an hour apart, five contracts captured at each. */
  const captures = (): Array<{ ts: number; data: Capture }> => {
    const rows: Array<{ ts: number; data: Capture }> = []
    for (let h = 0; h < 12; h++) {
      for (const token of ['A', 'B', 'C', 'D', 'E']) {
        rows.push({ ts: 1_000_000 + h * 3_600_000 + token.charCodeAt(0), data: { token } })
      }
    }
    return rows
  }

  /** The shape of a big store: sampled history, exact tail. */
  class SampledReader {
    readonly rows = captures()
    async isOversized() { return true }
    /** One record per settlement — what a time-even sample leaves of a cluster. */
    async readSampled() {
      const first = new Map<number, { ts: number; data: Capture }>()
      for (const r of this.rows) {
        const settlement = Math.floor(r.ts / 3_600_000)
        if (!first.has(settlement)) first.set(settlement, r)
      }
      return [...first.values()]
    }
    async readLast(_key: string, n: number) { return this.rows.slice(-n) }
    async readAll() { return this.rows }
    async readLatest() { return this.rows[this.rows.length - 1] ?? null }
    async readRange() { return this.rows }
    async count() { return this.rows.length }
    async keys() { return ['k'] }
    stream() { throw new Error('not used') }
  }

  class CaptureMonitor extends BaseMonitor<string, Capture> {
    override readonly mode = MonitorMode.Subscribe
    readonly reader = new SampledReader()
    get monitorName() { return 'captures' }
    protected override startSubscribe(): void {}
    protected override stopSubscribe(): void {}
    override getReader() { return this.reader as never }
    override plots(): MonitorPlotDef<Capture>[] {
      return [
        {
          id: 'pick',
          title: 'Which capture',
          kind: 'line',
          options: (records) => records.map(r => ({ value: `${r.data.token}@${r.ts}`, label: r.data.token })),
          extract: () => [],
        },
        {
          id: 'curve',
          title: 'No picker here',
          kind: 'line',
          extract: (records) => [{ label: 'all', points: records.map(r => ({ x: r.ts, y: 1 })) }],
        },
      ]
    }
  }

  const runtimeWith = (m: CaptureMonitor) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-plot-cluster-'))
    const rt = new OpenWhaleRuntime({ dataDir: dir, credentialStore })
    rt.registerMonitor({ id: 'captures', name: 'Captures', source: 'builtin', createdAt: '', updatedAt: '' }, m)
    return rt
  }

  it('lists every capture of the newest settlements, not one of them', async () => {
    const m = new CaptureMonitor({ dataDir: os.tmpdir() })
    const res = await runtimeWith(m).monitorPlotSeries('captures', 'pick', 'k', 0)
    const newest = 1_000_000 + 11 * 3_600_000
    const atNewest = (res.options ?? []).filter(o => Number(o.value.split('@')[1]) >= newest)
    expect(atNewest.map(o => o.label).sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  it('leaves the sampled overview alone for the older stretch', async () => {
    const m = new CaptureMonitor({ dataDir: os.tmpdir() })
    const res = await runtimeWith(m).monitorPlotSeries('captures', 'pick', 'k', 0)
    // The oldest settlement is still represented — the tail did not replace history
    expect((res.options ?? []).some(o => Number(o.value.split('@')[1]) < 1_000_000 + 3_600_000)).toBe(true)
  })

  it('a panel with no picker still pays only for the sample', async () => {
    const m = new CaptureMonitor({ dataDir: os.tmpdir() })
    const res = await runtimeWith(m).monitorPlotSeries('captures', 'curve', 'k', 0)
    // 12 settlements, one record each: the tail was never read
    expect(res.series[0]!.points).toHaveLength(12)
  })
})
