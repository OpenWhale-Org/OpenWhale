import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { OpenWhaleRuntime } from '../../runtime/OpenWhaleRuntime.js'
import { BaseMonitor, MonitorMode } from '../BaseMonitor.js'
import type { CredentialStore, MonitorPlotDef, MonitorRecord, PlotRegion, PlotYRange } from '../../index.js'

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'none', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

interface Sample extends Record<string, unknown> { value: number; open: boolean }

/**
 * Panels over one record set: one that shades both axes, one that declares no
 * shading at all, and one whose regions() throws — the case that must cost the
 * shading and nothing else.
 */
class ShadedMonitor extends BaseMonitor<string, Sample> {
  override readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'shaded' }
  protected override startSubscribe(): void {}
  protected override stopSubscribe(): void {}

  /** The windows each hook was handed, for the "same records as extract" assertions. */
  extractSaw: MonitorRecord<Sample>[] | undefined
  regionsSaw: MonitorRecord<Sample>[] | undefined
  yRangesSaw: MonitorRecord<Sample>[] | undefined

  override plots(): MonitorPlotDef<Sample>[] {
    const line = (records: MonitorRecord<Sample>[]) =>
      [{ label: 'value', points: records.map(r => ({ x: r.ts, y: r.data.value })) }]
    return [
      {
        id: 'both',
        title: 'Deviation, against its closed sessions and its stop',
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
          // …plus the instant the anchor reset: zero extent, so a line.
          out.push({ from: 1003, to: 1003, label: 'anchor reset' })
          return out
        },
        yRanges: (records) => {
          this.yRangesSaw = records
          return [
            { from: -0.5, to: 0.5, label: 'no-trade', tone: 'neutral' },
            { from: 4, to: 4, label: 'stop', tone: 'warn' },
            // Structural, and far outside anything this panel plots.
            { from: 900, to: 1000, label: 'off the frame', tone: 'warn' },
          ]
        },
        extract: (records) => { this.extractSaw = records; return line(records) },
      },
      { id: 'plain', title: 'No shading at all', kind: 'line', extract: line },
      {
        id: 'brokenX',
        title: 'A regions() that throws',
        kind: 'line',
        regions: () => { throw new Error('boom') },
        yRanges: () => [{ from: 0, to: 1 }],
        extract: line,
      },
      {
        id: 'brokenY',
        title: 'A yRanges() that throws',
        kind: 'line',
        regions: () => [{ from: 1000, to: 1001 }],
        yRanges: () => { throw new Error('boom') },
        extract: line,
      },
    ]
  }
}

let dataDir: string
let runtime: OpenWhaleRuntime
let monitor: ShadedMonitor

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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-plot-shading-'))
  runtime = new OpenWhaleRuntime({ dataDir, credentialStore })
  monitor = new ShadedMonitor({ dataDir })
  runtime.registerMonitor(
    { id: 'shaded', name: 'Shaded', source: 'builtin', createdAt: '', updatedAt: '' },
    monitor,
  )
  await (monitor as unknown as { appendHistorical(k: string, r: typeof ROWS): Promise<void> })
    .appendHistorical('k', ROWS)
})

function panel(plotId: string, n = 500) {
  return runtime.monitorPlotSeries('shaded', plotId, 'k', n)
}

describe('a panel def carrying shading', () => {
  it('still satisfies MonitorPlotDef on both axes', () => {
    // Type-level: these only compile if `regions` and `yRanges` are part of
    // the shared base of both plot flavours, single-select AND multi.
    const single: MonitorPlotDef<Sample> = {
      id: 's', title: 's', kind: 'line',
      regions: () => [{ from: 0, to: 1 }],
      yRanges: () => [{ from: -1, to: 1 }],
      extract: () => [],
    }
    const multi: MonitorPlotDef<Sample> = {
      id: 'm', title: 'm', kind: 'line', multi: true,
      regions: (records) => records.map(r => ({ from: r.ts, to: r.ts + 1, label: 'r', tone: 'good' as const })),
      yRanges: (records) => records.map(r => ({ from: r.data.value, to: r.data.value, label: 'y', tone: 'warn' as const })),
      options: () => [{ value: 'a', label: 'a' }],
      extract: () => [],
    }
    expect(single.regions?.([])).toEqual([{ from: 0, to: 1 }])
    expect(single.yRanges?.([])).toEqual([{ from: -1, to: 1 }])
    const row: MonitorRecord<Sample> = { ts: 7, data: { value: 3, open: true } }
    expect(multi.regions?.([row])).toEqual([{ from: 7, to: 8, label: 'r', tone: 'good' }])
    expect(multi.yRanges?.([row])).toEqual([{ from: 3, to: 3, label: 'y', tone: 'warn' }])
  })

  it('keeps both hooks out of the serialisable panel metadata', () => {
    const info = runtime.monitorPlots('shaded').find(p => p.id === 'both')!
    expect(info).toBeDefined()
    expect('regions' in info).toBe(false)
    expect('yRanges' in info).toBe(false)
  })
})

describe('resolving shading server-side', () => {
  it('carries both axes in the rendered payload', async () => {
    const res = await panel('both')
    expect(res.regions).toEqual([
      { from: 1002, to: 1004, label: 'closed', tone: 'warn' },
      { from: 1003, to: 1003, label: 'anchor reset' },
    ])
    expect(res.yRanges).toEqual([
      { from: -0.5, to: 0.5, label: 'no-trade', tone: 'neutral' },
      { from: 4, to: 4, label: 'stop', tone: 'warn' },
      { from: 900, to: 1000, label: 'off the frame', tone: 'warn' },
    ])
  })

  it('invokes both hooks with the same record window as extract', async () => {
    await panel('both', 4)
    expect(monitor.regionsSaw).toBe(monitor.extractSaw)
    expect(monitor.yRangesSaw).toBe(monitor.extractSaw)
    expect(monitor.extractSaw?.map(r => r.ts)).toEqual([1002, 1003, 1004, 1005])
  })

  it('follows a narrowed window rather than the whole history', async () => {
    const res = await panel('both', 2)
    // Only ts 1004/1005 are in view, both with the market open — no closed run
    expect(res.regions).toEqual([{ from: 1003, to: 1003, label: 'anchor reset' }])
  })

  it('omits both fields for a panel that declares neither', async () => {
    const res = await panel('plain')
    expect(res.regions).toBeUndefined()
    expect(res.yRanges).toBeUndefined()
    expect(res.series[0]!.points).toHaveLength(ROWS.length)
  })

  it('leaves the series intact when regions() throws', async () => {
    const res = await panel('brokenX')
    expect(res.series.map(s => s.label)).toEqual(['value'])
    expect(res.series[0]!.points).toHaveLength(ROWS.length)
    // One catch covers both axes on purpose: shading fails as a unit.
    expect(res.regions).toBeUndefined()
    expect(res.yRanges).toBeUndefined()
  })

  it('leaves the series intact when yRanges() throws', async () => {
    const res = await panel('brokenY')
    expect(res.series.map(s => s.label)).toEqual(['value'])
    expect(res.series[0]!.points).toHaveLength(ROWS.length)
    expect(res.regions).toBeUndefined()
    expect(res.yRanges).toBeUndefined()
  })

  it('passes a zero-extent range through untouched, on both axes', async () => {
    // The renderer turns from === to into a reference line; the runtime must
    // not "helpfully" drop it as an empty band on the way out.
    const res = await panel('both')
    expect(res.regions).toContainEqual({ from: 1003, to: 1003, label: 'anchor reset' })
    expect(res.yRanges).toContainEqual({ from: 4, to: 4, label: 'stop', tone: 'warn' })
  })
})

describe('the declared shading contract is unit-agnostic', () => {
  it('accepts a y-range in the panel unit and an x-region in epoch ms side by side', () => {
    const region: PlotRegion = { from: 1_700_000_000_000, to: 1_700_000_060_000, tone: 'good' }
    const yRange: PlotYRange = { from: -2, to: 2, tone: 'warn' }
    expect(region.to - region.from).toBe(60_000)
    expect(yRange.to - yRange.from).toBe(4)
  })
})
