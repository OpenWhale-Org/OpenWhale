import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { BaseMonitor, MonitorMode } from '../BaseMonitor.js'

interface Tick { value: number }

/** Poll until a condition holds — the backfill chain does real fs I/O, so fixed sleeps are flaky. */
async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

/** Let the whole backfill chain settle when the expected end state is "nothing happened". */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 100))
}

class HistoryMonitor extends BaseMonitor<string, Tick> {
  override readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'history-test' }

  /** Canned archive: ts → value. */
  archive: Array<{ ts: number; data: Tick }> = []
  backfillCalls: Array<{ key: string; since: number | undefined }> = []
  backfillError?: Error
  started: string[] = []
  stopped: string[] = []
  /** Resolves when the test releases the backfill, to observe ordering. */
  gate?: Promise<void>

  protected override async backfill(key: string, since: number | undefined, signal: AbortSignal) {
    this.backfillCalls.push({ key, since })
    if (this.gate) await this.gate
    if (this.backfillError) throw this.backfillError
    if (signal.aborted) return []
    return this.archive
  }

  protected override startSubscribe(key: string): void { this.started.push(key) }
  protected override stopSubscribe(key: string): void { this.stopped.push(key) }
}

/** Same feed with no backfill hook — the unchanged legacy path. */
class LiveOnlyMonitor extends BaseMonitor<string, Tick> {
  override readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'live-only-test' }
  started: string[] = []
  protected override startSubscribe(key: string): void { this.started.push(key) }
  protected override stopSubscribe(): void {}
}

let dataDir: string
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-backfill-')) })

function readFile(monitorName: string, key: string): Array<{ ts: number; data: Tick }> {
  const file = path.join(dataDir, 'monitors', monitorName, `${key}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
}

describe('backfill capability', () => {
  it('supportsBackfill reflects whether the hook is implemented', () => {
    expect(new HistoryMonitor({ dataDir }).supportsBackfill).toBe(true)
    expect(new LiveOnlyMonitor({ dataDir }).supportsBackfill).toBe(false)
  })

  it('a monitor without the hook starts live immediately (unchanged path)', () => {
    const monitor = new LiveOnlyMonitor({ dataDir })
    monitor.subscribe('k')
    expect(monitor.started).toEqual(['k'])
  })
})

describe('first subscribe', () => {
  it('persists history BEFORE live collection starts', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    monitor.archive = [
      { ts: 1_000, data: { value: 1 } },
      { ts: 2_000, data: { value: 2 } },
    ]
    let release!: () => void
    monitor.gate = new Promise<void>(r => { release = r })

    monitor.subscribe('k')
    await waitFor(() => monitor.backfillCalls.length === 1)
    // Live collection must not have started while history is still landing.
    expect(monitor.started).toEqual([])

    release()
    await waitFor(() => monitor.started.length === 1)
    expect(monitor.started).toEqual(['k'])
    expect(readFile('history-test', 'k')).toEqual(monitor.archive)
  })

  it('preserves each record\'s own timestamp, not the write time', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    monitor.archive = [{ ts: 42, data: { value: 7 } }]
    monitor.subscribe('k')
    await waitFor(() => readFile('history-test', 'k').length === 1)
    expect(readFile('history-test', 'k')[0]!.ts).toBe(42)
  })

  it('does NOT dispatch emit handlers — history must not fire strategies', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    monitor.archive = [{ ts: 1_000, data: { value: 1 } }]
    const fired: unknown[] = []
    monitor.addEmitHandler((key, data) => { fired.push({ key, data }) })

    monitor.subscribe('k')
    await waitFor(() => monitor.started.length === 1)
    expect(readFile('history-test', 'k')).toHaveLength(1)
    expect(fired).toEqual([])
  })

  it('runs once per key, not per subscriber', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    monitor.archive = [{ ts: 1_000, data: { value: 1 } }]
    monitor.subscribe('k')
    monitor.subscribe('k')
    await waitFor(() => monitor.started.length === 1)
    expect(monitor.backfillCalls).toHaveLength(1)
    expect(readFile('history-test', 'k')).toHaveLength(1)
  })
})

describe('incremental watermark', () => {
  it('passes the newest stored ts as `since` and drops anything at or before it', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    monitor.archive = [
      { ts: 1_000, data: { value: 1 } },
      { ts: 2_000, data: { value: 2 } },
    ]
    monitor.subscribe('k')
    await waitFor(() => monitor.started.length === 1)
    monitor.unsubscribe('k')

    // Second subscribe: the file is the watermark. A source that re-serves
    // overlapping history must not duplicate it.
    const monitor2 = new HistoryMonitor({ dataDir })
    monitor2.archive = [
      { ts: 2_000, data: { value: 2 } },   // already stored — dropped
      { ts: 3_000, data: { value: 3 } },
    ]
    monitor2.subscribe('k')
    await waitFor(() => monitor2.started.length === 1)

    expect(monitor2.backfillCalls).toEqual([{ key: 'k', since: 2_000 }])
    expect(readFile('history-test', 'k').map(r => r.ts)).toEqual([1_000, 2_000, 3_000])
  })

  it('`since` is undefined on a cold key', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    monitor.subscribe('fresh')
    await waitFor(() => monitor.backfillCalls.length === 1)
    expect(monitor.backfillCalls).toEqual([{ key: 'fresh', since: undefined }])
  })

  it('sorts out-of-order archive records ascending', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    monitor.archive = [
      { ts: 3_000, data: { value: 3 } },
      { ts: 1_000, data: { value: 1 } },
      { ts: 2_000, data: { value: 2 } },
    ]
    monitor.subscribe('k')
    await waitFor(() => readFile('history-test', 'k').length === 3)
    expect(readFile('history-test', 'k').map(r => r.ts)).toEqual([1_000, 2_000, 3_000])
  })
})

describe('failure and cancellation', () => {
  it('a failing backfill is non-fatal — live collection still starts', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    monitor.backfillError = new Error('venue archive down')
    monitor.subscribe('k')
    await waitFor(() => monitor.started.length === 1)
    expect(monitor.started).toEqual(['k'])
    expect(readFile('history-test', 'k')).toEqual([])
  })

  it('unsubscribing mid-backfill aborts it and skips the live start', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    monitor.archive = [{ ts: 1_000, data: { value: 1 } }]
    let release!: () => void
    monitor.gate = new Promise<void>(r => { release = r })

    monitor.subscribe('k')
    await waitFor(() => monitor.backfillCalls.length === 1)
    monitor.unsubscribe('k')
    release()
    await settle()

    expect(monitor.started).toEqual([])
    expect(readFile('history-test', 'k')).toEqual([])
  })

  it('status reports keys currently backfilling', async () => {
    const monitor = new HistoryMonitor({ dataDir })
    let release!: () => void
    monitor.gate = new Promise<void>(r => { release = r })

    monitor.subscribe('k')
    await waitFor(() => monitor.backfillCalls.length === 1)
    expect(monitor.status().backfillingKeys).toEqual(['k'])

    release()
    await waitFor(() => monitor.started.length === 1)
    expect(monitor.status().backfillingKeys).toBeUndefined()
  })
})
