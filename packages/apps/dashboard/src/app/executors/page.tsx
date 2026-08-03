import { ExecutorsClient } from './ExecutorsClient'
import { fetchCredentials, fetchCredentialTypes, fetchExecutorStatus } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function ExecutorsPage() {
  const [executors, credentials, credentialTypes] = await Promise.all([
    fetchExecutorStatus(), fetchCredentials(), fetchCredentialTypes(),
  ])
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Executors</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Fire instructions manually, inspect execution records, and tail executor logs. Manual fires are REAL executions.
        </p>
      </div>
      <ExecutorsClient initialExecutors={executors} credentials={credentials} credentialTypes={credentialTypes} />
    </div>
  )
}
