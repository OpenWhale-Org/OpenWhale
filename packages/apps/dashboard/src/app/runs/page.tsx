import { RunsClient } from './RunsClient'
import { fetchInstances } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function RunsPage() {
  // Instances only, for names and the filter: the runs themselves are fetched
  // client-side, where the page keeps them fresh.
  return <RunsClient instances={await fetchInstances()} />
}
