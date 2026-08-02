import { CredentialsClient } from './CredentialsClient'
import { fetchCredentials, fetchCredentialTypes } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function CredentialsPage() {
  const [credentials, credentialTypes] = await Promise.all([fetchCredentials(), fetchCredentialTypes()])
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Credentials</h1>
      </div>
      <CredentialsClient initialCredentials={credentials} credentialTypes={credentialTypes} />
    </div>
  )
}
