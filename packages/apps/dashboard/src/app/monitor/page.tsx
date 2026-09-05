import { MonitorClient } from './MonitorClient'
import { fetchMonitorDefinitions, fetchMonitorInstancesData, fetchCredentials } from '@/lib/data'
import { serverT } from '@/i18n/server'

export const dynamic = 'force-dynamic'

export default async function MonitorPage() {
  const [monitors, { instances, implementations, pendingKeys }, credentials, t] = await Promise.all([
    fetchMonitorDefinitions(), fetchMonitorInstancesData(), fetchCredentials(), serverT(),
  ])
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">{t('monitor.title')}</h1>
      </div>
      {/* Instances used to be a separate table below everything; they now live
          inside the selected monitor's detail, where the contract is in view. */}
      <MonitorClient
        monitors={monitors}
        instances={instances}
        implementations={implementations}
        pendingKeys={pendingKeys}
        credentials={credentials}
      />
    </div>
  )
}
