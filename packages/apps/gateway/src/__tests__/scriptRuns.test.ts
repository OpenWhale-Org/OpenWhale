import { describe, it, expect, vi, beforeAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import { ScriptRuns, runKey, FINISHED_RUN_TTL_MS, type RunFrame } from '../scriptRuns.js'
import { watchLoopLag } from '../loopLag.js'

/** A script the test finishes by hand. */
const manual = () => {
  let emit: (l: string) => void = () => {}
  let signal: AbortSignal | undefined
  let finish: (f: RunFrame) => void = () => {}
  let starts = 0
  const start = (e: (l: string) => void, s: AbortSignal) => {
    starts++; emit = e; signal = s
    return new Promise<RunFrame>((r) => { finish = r })
  }
  return { start, emit: (l: string) => emit(l), finish: (f: RunFrame) => finish(f), aborted: () => signal?.aborted === true, starts: () => starts }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('ScriptRuns', () => {
  it('the same script with the same params joins the run in flight', () => {
    const runs = new ScriptRuns()
    const s = manual()
    const a = runs.open(runKey('p/x', { a: 1, b: 2 }), 'one', s.start)
    const b = runs.open(runKey('p/x', { b: 2, a: 1 }), 'two', s.start)
    expect(a.joined).toBe(false)
    expect(b.joined).toBe(true)
    expect(b.run).toBe(a.run)
    expect(s.starts()).toBe(1)
    expect(runs.open(runKey('p/x', { a: 2 }), 'three', manual().start).joined).toBe(false)
  })

  it('a viewer that left misses nothing: the run goes on and replays from where it stopped reading', async () => {
    const runs = new ScriptRuns()
    const s = manual()
    const { run } = runs.open('k', 'one', s.start)
    const first: RunFrame[] = []
    const detach = runs.watch(run, 0, f => first.push(f))
    s.emit('a'); s.emit('b')
    detach()
    s.emit('c')
    expect(s.aborted()).toBe(false)
    s.finish({ type: 'result', text: 'done' })
    await tick()

    const again: RunFrame[] = []
    const retry = runs.open('k', 'one', manual().start)
    expect(retry.run).toBe(run)
    runs.watch(retry.run, first.length, f => again.push(f))
    expect(first).toEqual([{ type: 'line', text: 'a' }, { type: 'line', text: 'b' }])
    expect(again).toEqual([{ type: 'line', text: 'c' }, { type: 'result', text: 'done' }])
  })

  it('a finished run is not joined by a fresh press, and is forgotten after its keep time', async () => {
    let now = 1_000
    const runs = new ScriptRuns(() => now)
    const s = manual()
    const { run } = runs.open('k', 'one', s.start)
    s.finish({ type: 'result', text: 'done' })
    await tick()
    expect(runs.open('k', 'two', manual().start).run).not.toBe(run)
    expect(runs.open('k', 'one', manual().start).run).toBe(run)
    now += FINISHED_RUN_TTL_MS + 1
    expect(runs.open('k', 'one', manual().start).run).not.toBe(run)
    expect(runs.get(run.id)).toBeUndefined()
  })

  it('a script that throws ends in an error frame, and Stop reaches only a run still going', async () => {
    const runs = new ScriptRuns()
    const frames: RunFrame[] = []
    const { run } = runs.open('k', undefined, async () => { throw new Error('venue said no') })
    runs.watch(run, 0, f => frames.push(f))
    await tick()
    expect(frames).toEqual([{ type: 'error', error: 'venue said no' }])
    expect(runs.stop(run.id)).toBe(false)

    const s = manual()
    const live = runs.open('other', undefined, s.start).run
    expect(runs.stop(live.id)).toBe(true)
    expect(s.aborted()).toBe(true)
    expect(runs.stop('nope')).toBe(false)
  })
})

describe('watchLoopLag', () => {
  it('reports a stall by how late its own timer fired', async () => {
    vi.useFakeTimers()
    try {
      let now = 0
      const stalls: number[] = []
      const stop = watchLoopLag(s => stalls.push(s.ms), { intervalMs: 100, thresholdMs: 1_000, now: () => now })
      now = 100; vi.advanceTimersByTime(100)
      now = 3_200; vi.advanceTimersByTime(100)
      now = 3_300; vi.advanceTimersByTime(100)
      stop()
      expect(stalls).toEqual([3_000])
    } finally { vi.useRealTimers() }
  })
})

/* Over a real socket: the hang-up is what this whole change is about. */
let script: { aborted: () => boolean; emit: (l: string) => void; finish: () => void; starts: number }
vi.mock('../runtime.js', () => ({
  getRuntime: () => undefined,
  getDatabase: () => undefined,
  ensureStarted: async () => ({
    scriptRunsInBackground: (id: string) => id === 'x/report',
    runScript: async (_id: string, _params: unknown, emit?: (l: string) => void, signal?: AbortSignal) => {
      let done: () => void = () => {}
      const finished = new Promise<void>((r) => { done = r })
      script = { aborted: () => signal?.aborted === true, emit: l => emit?.(l), finish: done, starts: (script?.starts ?? 0) + 1 }
      emit?.('one')
      await finished
      return { text: 'the report' }
    },
  }),
}))

describe('a background script over the stream route', () => {
  let port = 0
  beforeAll(async () => {
    const { buildRouter } = await import('../routes.js')
    const app = express()
    app.use(express.json())
    app.use(buildRouter())
    const srv = app.listen(0)
    await new Promise((r) => srv.once('listening', r))
    port = (srv.address() as AddressInfo).port
    return () => srv.close()
  })
  const post = (body: unknown, signal?: AbortSignal) => fetch(`http://127.0.0.1:${port}/api/scripts/x/report/stream`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
  })
  const frames = async (res: Response, until: (f: Record<string, unknown>) => boolean) => {
    const out: Array<Record<string, unknown>> = []
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return out
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n'); buf = parts.pop() ?? ''
        for (const p of parts) {
          if (!p.trim()) continue
          const f = JSON.parse(p) as Record<string, unknown>
          if (f['type'] !== 'ping') out.push(f)
          if (until(f)) return out
        }
      }
    } catch { return out }
  }

  it('hanging up does not stop it, pressing again does not start another, and the retry gets the rest', async () => {
    const hangUp = new AbortController()
    const first = await frames(await post({ params: {}, attempt: 'press-1' }, hangUp.signal), f => f['type'] === 'line')
    expect(first.map(f => f['type'])).toEqual(['run', 'line'])
    expect(first[0]!['background']).toBe(true)
    hangUp.abort()
    await new Promise((r) => setTimeout(r, 30))
    expect(script.aborted()).toBe(false)

    const retry = post({ params: {}, attempt: 'press-1', from: 1 })
    const res = await retry
    const reading = frames(res, f => f['type'] === 'result')
    await new Promise((r) => setTimeout(r, 30))
    expect(script.starts).toBe(1)
    script.emit('two')
    script.finish()
    const rest = await reading
    expect(rest[0]).toMatchObject({ type: 'run', id: first[0]!['id'], joined: true })
    expect(rest.slice(1)).toEqual([{ type: 'line', text: 'two' }, { type: 'result', text: 'the report' }])
  })
})
