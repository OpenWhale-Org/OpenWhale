'use client'

import { useState } from 'react'
import type { StrategyInstance } from '@openwhale/core'

interface Props {
  initialInstances: StrategyInstance[]
}

export function InstancesClient({ initialInstances }: Props) {
  const [instances, setInstances] = useState(initialInstances)
  const [loading, setLoading] = useState(false)

  async function refresh() {
    setLoading(true)
    const res = await fetch('/api/instances')
    if (res.ok) setInstances(await res.json())
    setLoading(false)
  }

  async function deactivate(id: string) {
    await fetch(`/api/instances/${id}`, { method: 'DELETE' })
    await refresh()
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={refresh}
          disabled={loading}
          className="px-4 py-2 rounded-md text-sm transition-colors"
          style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {instances.length === 0 ? (
        <div
          className="rounded-lg p-8 text-center text-sm"
          style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
        >
          No active instances. Activate a strategy to get started.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {instances.map((inst) => (
            <InstanceCard key={inst.id} instance={inst} onDeactivate={() => deactivate(inst.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

function InstanceCard({
  instance,
  onDeactivate,
}: {
  instance: StrategyInstance
  onDeactivate: () => void
}) {
  return (
    <div
      className="rounded-lg p-4 flex items-start justify-between gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{instance.name}</span>
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{
              background: instance.enabled ? '#14532d' : '#3f1f1f',
              color: instance.enabled ? 'var(--success)' : 'var(--danger)',
            }}
          >
            {instance.enabled ? 'enabled' : 'disabled'}
          </span>
        </div>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {instance.strategyId} · {instance.id}
        </span>
        {instance.accounts && instance.accounts.length > 0 && (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            Accounts: {instance.accounts.join(', ')}
          </span>
        )}
      </div>
      <button
        onClick={onDeactivate}
        className="shrink-0 px-3 py-1.5 rounded-md text-xs transition-colors"
        style={{ background: '#3f1f1f', color: 'var(--danger)', border: '1px solid #7f1d1d' }}
      >
        Deactivate
      </button>
    </div>
  )
}
