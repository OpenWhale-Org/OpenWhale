import { AccountsClient } from './AccountsClient'
import { fetchAccountsData, fetchCredentials, fetchCredentialTypes } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function AccountsPage() {
  const [{ accounts, implementations, snapshots }, credentials, credentialTypes] = await Promise.all([
    fetchAccountsData(), fetchCredentials(), fetchCredentialTypes(),
  ])
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Accounts</h1>
      </div>
      <AccountsClient
        initialAccounts={accounts}
        initialSnapshots={snapshots}
        implementations={implementations}
        credentials={credentials}
        credentialTypes={credentialTypes}
      />
    </div>
  )
}
