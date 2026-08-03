import { MonitorClient } from './MonitorClient'
import { MonitorInstancesSection } from './MonitorInstancesSection'
import { fetchMonitorDefinitions, fetchMonitorInstancesData, fetchCredentials } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function MonitorPage() {
  const [monitors, { instances, implementations, pendingKeys }, credentials] = await Promise.all([
    fetchMonitorDefinitions(), fetchMonitorInstancesData(), fetchCredentials(),
  ])
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Monitor</h1>
      </div>
      <MonitorClient monitors={monitors} />
      <MonitorInstancesSection
        initialInstances={instances}
        implementations={implementations}
        pendingKeys={pendingKeys}
        credentials={credentials}
      />
    </div>
  )
}
