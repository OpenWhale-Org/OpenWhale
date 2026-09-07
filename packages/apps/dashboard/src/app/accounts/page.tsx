import { AccountsClient } from './AccountsClient'
import { fetchAccountsData, fetchCredentials, fetchCredentialTypes } from '@/lib/data'
import { serverT } from '@/i18n/server'

export const dynamic = 'force-dynamic'

export default async function AccountsPage() {
  const [{ accounts, implementations, snapshots }, credentials, credentialTypes, t] = await Promise.all([
    fetchAccountsData(), fetchCredentials(), fetchCredentialTypes(), serverT(),
  ])
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">{t('accounts.title')}</h1>
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
