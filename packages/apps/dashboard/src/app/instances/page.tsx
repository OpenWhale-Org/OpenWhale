import { InstancesClient } from './InstancesClient'
import { fetchInstances } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function InstancesPage() {
  const instances = await fetchInstances()
  // The header lives in the client component: its actions (Refresh, New
  // Instance) are driven by that component's state, and a title row split
  // across the boundary cannot hold them.
  return <InstancesClient initialInstances={instances} />
}
