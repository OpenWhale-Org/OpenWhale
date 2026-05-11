'use client'

import { useEffect, useRef, useState } from 'react'
import type { MonitorDefinition } from '@openwhale/core'

interface SseEvent {
  monitor: string
  key: string
  data: unknown
  ts: number
}

interface Props {
  monitors: MonitorDefinition[]
}

export function MonitorClient({ monitors }: Props) {
  const [events, setEvents] = useState<SseEvent[]>([])
  const [connected, setConnected] = useState(false)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/events')
    esRef.current = es

    es.onopen = () => setConnected(true)
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      const event = JSON.parse(e.data as string) as SseEvent
      setEvents((prev) => [event, ...prev].slice(0, 200))
    }

    return () => {
      es.close()
      setConnected(false)
    }
  }, [])

  return (
    <div className="flex flex-col gap-6">
      {/* Registered monitors */}
      <section>
        <h2 className="text-sm font-medium mb-3" style={{ color: 'var(--muted)' }}>
          Registered Monitors
        </h2>
        {monitors.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No monitors registered.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {monitors.map((m) => (
              <span
                key={m.id}
                className="px-3 py-1 rounded-full text-xs"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                {m.id}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Live event feed */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-sm font-medium" style={{ color: 'var(--muted)' }}>
            Live Events
          </h2>
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: connected ? 'var(--success)' : 'var(--danger)' }}
          />
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {connected ? 'connected' : 'disconnected'}
          </span>
        </div>

        <div
          className="rounded-lg overflow-hidden font-mono text-xs"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          {events.length === 0 ? (
            <div className="p-4" style={{ color: 'var(--muted)' }}>
              Waiting for events…
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {events.map((ev, i) => (
                <EventRow key={i} event={ev} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

function EventRow({ event }: { event: SseEvent }) {
  const time = new Date(event.ts).toLocaleTimeString()
  return (
    <div className="px-4 py-2 flex gap-3 items-start">
      <span className="shrink-0" style={{ color: 'var(--muted)' }}>
        {time}
      </span>
      <span style={{ color: 'var(--accent)' }}>{event.monitor}</span>
      <span style={{ color: 'var(--warning)' }}>{event.key}</span>
      <span className="truncate" style={{ color: 'var(--foreground)' }}>
        {JSON.stringify(event.data)}
      </span>
    </div>
  )
}
