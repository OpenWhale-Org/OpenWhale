import { ensureStarted } from '@/lib/runtime'

export const dynamic = 'force-dynamic'

/**
 * SSE endpoint — streams real-time monitor emit events and strategy run events to the browser.
 * Connect with: new EventSource('/api/events')
 *
 * Event types:
 *   - monitor_emit:  { type, monitor, key, data, ts }
 *   - strategy_run:  { type, instanceId, triggerId, instructions, monitorData, timestamp }
 */
export async function GET() {
  const runtime = await ensureStarted()

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (chunk: Uint8Array) => {
        if (closed) return
        try {
          controller.enqueue(chunk)
        } catch {
          closed = true
        }
      }

      const send = (payload: unknown) =>
        enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))

      // Heartbeat every 15 s
      const heartbeat = setInterval(() => {
        enqueue(encoder.encode(': heartbeat\n\n'))
      }, 15_000)

      // Monitor emit events
      for (const def of runtime.listMonitors()) {
        const monitor = runtime.getMonitor(def.id)
        if (!monitor) continue
        monitor.setEmitHandler((key: string, data: unknown) => {
          send({ type: 'monitor_emit', monitor: def.id, key, data, ts: Date.now() })
        })
      }

      // Strategy run events
      runtime.setStrategyRunHandler((event) => {
        send({ type: 'strategy_run', ...event })
      })

      return () => {
        closed = true
        clearInterval(heartbeat)
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
