import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '@openwhale/core'
import { RegistryClient } from './RegistryClient'

interface RegistryData {
  monitors: MonitorDefinition[]
  executors: ExecutorDefinition[]
  strategies: StrategyDefinition[]
}

async function getRegistry(): Promise<RegistryData> {
  const res = await fetch('http://localhost:3000/api/registry', { cache: 'no-store' })
  if (!res.ok) return { monitors: [], executors: [], strategies: [] }
  return res.json() as Promise<RegistryData>
}

export default async function RegistryPage() {
  const data = await getRegistry()
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Registry</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Registered monitors, strategies, and executors — import compiled TypeScript to add new ones
        </p>
      </div>
      <RegistryClient initialData={data} />
    </div>
  )
}
