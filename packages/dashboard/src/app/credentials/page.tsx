import type { CredentialInfo } from '@openwhale/core'
import { CredentialsClient } from './CredentialsClient'

async function getCredentials(): Promise<CredentialInfo[]> {
  const res = await fetch('http://localhost:3000/api/credentials', { cache: 'no-store' })
  if (!res.ok) return []
  return res.json() as Promise<CredentialInfo[]>
}

export default async function CredentialsPage() {
  const credentials = await getCredentials()
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Credentials</h1>
      </div>
      <CredentialsClient initialCredentials={credentials} />
    </div>
  )
}
