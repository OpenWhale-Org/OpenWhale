import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { OpenWhaleRuntime } from '../../runtime/OpenWhaleRuntime.js'
import { BaseMonitor, MonitorMode } from '../BaseMonitor.js'
import type { CredentialStore, MonitorPlotDef, MonitorRecord, PlotRegion } from '../../index.js'

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'none', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

interface Sample extends Record<string, unknown> { value: number; open: boolean }

/**
 * Three panels over one record set: one that shades the stretches where the
 * listing market was shut, one that declares no regions at all, and one whose
 * regions() throws — the case that must cost the shading and nothing else.
 */
class RegionMonitor extends BaseMonitor<string, Sample> {
  override readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'regions' }
  protected override startSubscribe(): void {}
  protected override stopSubscribe(): void {}

  /** The windows each hook was handed, for the "same records as extract" assertion. */
  extractSaw: MonitorRecord<Sample>[] | undefined
  regionsSaw: MonitorRecord<Sample>[] | undefined

  override plots(): MonitorPlotDef<Sample>[] {
    const line = (records: MonitorRecord<Sample>[]) =>
      [{ label: 'value', points: records.map(r => ({ x: r.ts, y: r.data.value })) }]
    return [
      {
        id: 'shaded',
        title: 'Deviation, with the closed sessions behind it',
        kind: 'line',
        regions: (records) => {
          this.regionsSaw = records
          // Maximal runs of records taken while the market was shut.
          const out: PlotRegion[] = []
          let start: number | null = null
          for (const r of records) {
            if (!r.data.open && start === null) start = r.ts
            if (r.data.open && start !== null) { out.push({ from: start, to: r.ts, label: 'closed', tone: 'warn' }); start = null }
          }
          if (start !== null) out.push({ from: start, to: records[records.length - 1]!.ts + 1, label: 'closed', tone: 'warn' })
          return out
        },
        extract: (records) => { this.extractSaw = records; return line(records) },
      },
      { id: 'plain', title: 'No regions at all', kind: 'line', extract: line },
      {
        id: 'broken',
        title: 'A regions() that throws',
        kind: 'line',
        regions: () => { throw new Error('boom') },
        extract: line,
      },
    ]
  }
}

let dataDir: string
let runtime: OpenWhaleRuntime
let monitor: RegionMonitor

/* ts 1000..1005; the middle two were sampled with the market shut. */
const ROWS: Array<{ ts: number; data: Sample }> = [
  { ts: 1000, data: { value: 1, open: true } },
  { ts: 1001, data: { value: 2, open: true } },
  { ts: 1002, data: { value: 3, open: false } },
  { ts: 1003, data: { value: 4, open: false } },
  { ts: 1004, data: { value: 5, open: true } },
  { ts: 1005, data: { value: 6, open: true } },
]

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-plot-regions-'))
  runtime = new OpenWhaleRuntime({ dataDir, credentialStore })
  monitor = new RegionMonitor({ dataDir })
  runtime.registerMonitor(
    { id: 'regions', name: 'Regions', source: 'builtin', createdAt: '', updatedAt: '' },
    monitor,
  )
  await (monitor as unknown as { appendHistorical(k: string, r: typeof ROWS): Promise<void> })
    .appendHistorical('k', ROWS)
})

afterEach(() => { vi.restoreAllMocks() })

function panel(plotId: string, n = 500) {
  return runtime.monitorPlotSeries('regions', plotId, 'k', n)
}

describe('a panel def carrying regions', () => {
  it('still satisfies MonitorPlotDef', () => {
    // Type-level: the def below only compiles if `regions` is part of the
    // shared base of both plot flavours, single-select AND multi.
    const single: MonitorPlotDef<Sample> = {
      id: 's', title: 's', kind: 'line',
      regions: () => [{ from: 0, to: 1 }],
      extract: () => [],
    }
    const multi: MonitorPlotDef<Sample> = {
      id: 'm', title: 'm', kind: 'line', multi: true,
      regions: (records) => records.map(r => ({ from: r.ts, to: r.ts + 1, label: 'r', tone: 'good' as const })),
      options: () => [{ value: 'a', label: 'a' }],
      extract: () => [],
    }
    expect(single.regions?.([])).toEqual([{ from: 0, to: 1 }])
    expect(multi.regions?.([{ ts: 7, data: { value: 0, open: true } }]))
      .toEqual([{ from: 7, to: 8, label: 'r', tone: 'good' }])
  })

  it('keeps regions out of the serialisable panel metadata', () => {
    const info = runtime.monitorPlots('regions').find(p => p.id === 'shaded')!
    expect(info).toBeDefined()
    expect('regions' in info).toBe(false)
  })
})

describe('resolving regions server-side', () => {
  it('travels with the rendered payload', async () => {
    const res = await panel('shaded')
    expect(res.regions).toEqual([{ from: 1002, to: 1004, label: 'closed', tone: 'warn' }])
  })

  it('is invoked with the same record window as extract', async () => {
    await panel('shaded', 4)
    expect(monitor.regionsSaw).toBe(monitor.extractSaw)
    expect(monitor.regionsSaw?.map(r => r.ts)).toEqual([1002, 1003, 1004, 1005])
    // …and the shading follows that narrower window, not the whole history
    const res = await panel('shaded', 4)
    expect(res.regions).toEqual([{ from: 1002, to: 1004, label: 'closed', tone: 'warn' }])
  })

  it('omits the field entirely for a panel that declares none', async () => {
    const res = await panel('plain')
    expect(res.regions).toBeUndefined()
    expect(res.series[0]!.points).toHaveLength(ROWS.length)
  })

  it('leaves the series intact when regions() throws', async () => {
    const res = await panel('broken')
    expect(res.regions).toBeUndefined()
    expect(res.series.map(s => s.label)).toEqual(['value'])
    expect(res.series[0]!.points).toHaveLength(ROWS.length)
  })
})
