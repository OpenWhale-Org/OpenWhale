import type { MonitorDefinition } from '@openwhale/core'
import { MonitorClient } from './MonitorClient'

async function getMonitors(): Promise<{ monitors: MonitorDefinition[] }> {
  const res = await fetch('http://localhost:3000/api/monitor', { cache: 'no-store' })
  if (!res.ok) return { monitors: [] }
  return res.json() as Promise<{ monitors: MonitorDefinition[] }>
}

export default async function MonitorPage() {
  const { monitors } = await getMonitors()
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Monitor</h1>
      </div>
      <MonitorClient monitors={monitors} />
    </div>
  )
}
