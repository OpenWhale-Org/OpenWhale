import { ExecutionsClient } from './ExecutionsClient'
import { fetchInstances } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function ExecutionsPage() {
  // Instances only, for names and the filter: the executions themselves are
  // fetched client-side, where the page also receives the live ones.
  return <ExecutionsClient instances={await fetchInstances()} />
}
