import { InstancesClient } from './InstancesClient'
import { fetchInstances } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function InstancesPage() {
  const instances = await fetchInstances()
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
