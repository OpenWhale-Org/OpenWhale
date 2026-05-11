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
        <h1 className="text-2xl font-semibold">Strategy Instances</h1>
      </div>
      <InstancesClient initialInstances={instances} />
    </div>
  )
}
