import { fetchAlertSettings, fetchCredentials } from '@/lib/data'
import { AlertsClient } from './AlertsClient'

export const dynamic = 'force-dynamic'

export default async function AlertsPage() {
  const [settings, credentials] = await Promise.all([fetchAlertSettings(), fetchCredentials()])
  return <AlertsClient initialSettings={settings} credentials={credentials} />
}
