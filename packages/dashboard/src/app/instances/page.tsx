import type { StrategyInstance } from '@openwhale/core'
import { InstancesClient } from './InstancesClient'

async function getInstances(): Promise<StrategyInstance[]> {
  const res = await fetch('http://localhost:3000/api/instances', { cache: 'no-store' })
  if (!res.ok) return []
  return res.json() as Promise<StrategyInstance[]>
}

export default async function InstancesPage() {
  const instances = await getInstances()
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Strategy Instances</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            Activate and manage running strategy instances
          </p>
        </div>
      </div>
      <InstancesClient initialInstances={instances} />
    </div>
  )
}
