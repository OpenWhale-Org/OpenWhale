import { ensureStarted } from '@/lib/runtime'

export const dynamic = 'force-dynamic'

/**
 * SSE endpoint — streams real-time monitor emit events to the browser.
 * Connect with: new EventSource('/api/events')
 */
export async function GET() {
  const runtime = await ensureStarted()

  const encoder = new TextEncoder()
  let closed = false

  const stream = new ReadableStream({
    start(controller) {
      // Send a heartbeat every 15 s to keep the connection alive
      const heartbeat = setInterval(() => {
        if (closed) return
        controller.enqueue(encoder.encode(': heartbeat\n\n'))
      }, 15_000)

      // Subscribe to all registered monitors
      for (const def of runtime.listMonitors()) {
        const monitor = runtime.getMonitor(def.id)
        if (!monitor) continue

        monitor.setEmitHandler((key: string, data: unknown) => {
          if (closed) return
          const payload = JSON.stringify({ monitor: def.id, key, data, ts: Date.now() })
          controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
        })
      }

      // Cleanup when the client disconnects
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
