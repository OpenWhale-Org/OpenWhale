import { ExecutorsClient } from './ExecutorsClient'
import { fetchCredentials, fetchCredentialTypes, fetchExecutorStatus } from '@/lib/data'
import { serverT } from '@/i18n/server'

export const dynamic = 'force-dynamic'

export default async function ExecutorsPage() {
  const [executors, credentials, credentialTypes, t] = await Promise.all([
    fetchExecutorStatus(), fetchCredentials(), fetchCredentialTypes(), serverT(),
  ])
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{t('executors.title')}</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          {t('executors.subtitle')}
        </p>
      </div>
      <ExecutorsClient initialExecutors={executors} credentials={credentials} credentialTypes={credentialTypes} />
    </div>
  )
}
