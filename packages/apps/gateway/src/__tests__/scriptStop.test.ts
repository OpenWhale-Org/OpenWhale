import { describe, it, expect, vi, beforeAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'

/**
 * Stop, end to end over a real socket.
 *
 * The bug this pins down was invisible to any test that called the handler
 * directly: it was about WHEN an event fires relative to the handler's own
 * `await`. Since Node 16 a request stream emits 'close' on completion, and
 * express.json() completes it before the handler runs — so the old
 * `req.on('close')` either aborted every run instantly (attached
 * synchronously) or never fired at all (attached after an await, which is
 * what shipped). Only a real client on a real socket tells the two apart.
 */

let script: { aborted: () => boolean; started: Promise<void>; finish: () => void }

vi.mock('../runtime.js', () => ({
  getRuntime: () => undefined,
  getDatabase: () => undefined,
  ensureStarted: async () => {
    // A real await, as the live one is: the whole bug lived in this gap.
    await new Promise((r) => setTimeout(r, 1))
    return {
      runScript: async (_id: string, _params: unknown, emit?: (l: string) => void, signal?: AbortSignal) => {
        let done: () => void = () => {}
        const finished = new Promise<void>((r) => { done = r })
        script = { aborted: () => signal?.aborted === true, started: Promise.resolve(), finish: done }
        emit?.('working')
        await finished
        return { text: signal?.aborted === true ? 'stopped' : 'ran to the end' }
      },
    }
  },
}))

const listen = async () => {
  const { buildRouter } = await import('../routes.js')
  const app = express()
  app.use(buildRouter())
  const srv = app.listen(0)
  await new Promise((r) => srv.once('listening', r))
  return { srv, port: (srv.address() as AddressInfo).port }
}

/** Read NDJSON frames until `stop` says enough. */
const drain = async (body: ReadableStream<Uint8Array>, onFrame: (f: { type?: string; id?: string; text?: string }) => boolean) => {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n'); buf = parts.pop() ?? ''
      for (const p of parts) {
        if (!p.trim()) continue
        if (onFrame(JSON.parse(p) as { type?: string })) return
      }
    }
  } catch { /* the client hung up; that is the point of one of these tests */ }
}

describe('脚本的 Stop', () => {
  let port = 0
  let srv: { close: () => void }
  beforeAll(async () => { const s = await listen(); port = s.port; srv = s.srv; return () => srv.close() })

  const start = async (signal?: AbortSignal) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/scripts/x/y/stream`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: {} }), ...(signal ? { signal } : {}),
    })
    return res
  }

  it('运行中的脚本没有被误判为中止——这是之前同一个 bug 的另一半', async () => {
    const res = await start()
    let runId: string | undefined
    const reading = drain(res.body!, (f) => { if (f.type === 'run') runId = f.id; return f.type === 'line' })
    await reading
    expect(runId).toBeDefined()
    expect(script.aborted()).toBe(false)
    script.finish()
  })

  it('第一帧就给出 run id，Stop 从头一刻起就可用', async () => {
    const res = await start()
    let first: { type?: string; id?: string } | undefined
    await drain(res.body!, (f) => { first ??= f; return true })
    expect(first?.type).toBe('run')
    expect(first?.id).toBeTruthy()
    script.finish()
  })

  it('POST /stop 让脚本看到 aborted，并且脚本还能把自己的收尾写完', async () => {
    const res = await start()
    let runId = ''
    let terminal: { type?: string; text?: string } | undefined
    const reading = drain(res.body!, (f) => {
      if (f.type === 'run') {
        runId = f.id ?? ''
        // 停止是一条命令，不是挂电话：发完还继续读，等脚本自己的结论
        void fetch(`http://127.0.0.1:${port}/api/scripts/runs/${runId}/stop`, { method: 'POST' })
          .then(() => { script.finish() })
      }
      if (f.type === 'result') { terminal = f; return true }
      return false
    })
    await reading
    expect(terminal?.text).toBe('stopped')
  })

  it('停一个已经结束的运行，说不认识，而不是假装成功', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/scripts/runs/nope/stop`, { method: 'POST' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ stopped: false, reason: 'unknown' })
  })

  it('客户端直接断线，脚本也看得到——兜底那条路还在', async () => {
    const ctrl = new AbortController()
    const res = await start(ctrl.signal)
    await drain(res.body!, (f) => f.type === 'line')
    ctrl.abort()
    // socket 关闭是异步的，给它一拍
    await vi.waitFor(() => { expect(script.aborted()).toBe(true) }, { timeout: 2_000 })
    script.finish()
  })
})
