import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { OpenWhaleRuntime } from '../../runtime/OpenWhaleRuntime.js'
import { BaseMonitor, MonitorMode } from '../BaseMonitor.js'
import type { CredentialStore, MonitorPlotDef } from '../../index.js'

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
