import { AuroraOverview } from './AuroraOverview'
import { fetchAccountsData, fetchInstances } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  const [instances, { accounts, snapshots }] = await Promise.all([fetchInstances(), fetchAccountsData()])
  return <AuroraOverview instances={instances} accounts={accounts} snapshots={snapshots} />
}
