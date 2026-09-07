import { CredentialsClient } from './CredentialsClient'
import { fetchCredentials, fetchCredentialTypes } from '@/lib/data'
import { serverT } from '@/i18n/server'

export const dynamic = 'force-dynamic'

export default async function CredentialsPage() {
  const [credentials, credentialTypes, t] = await Promise.all([fetchCredentials(), fetchCredentialTypes(), serverT()])
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">{t('credentials.title')}</h1>
      </div>
      <CredentialsClient initialCredentials={credentials} credentialTypes={credentialTypes} />
    </div>
  )
}
