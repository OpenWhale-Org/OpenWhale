import { PluginsClient } from './PluginsClient'
import { fetchInstalledPlugins, fetchRegistry, fetchCredentialTypes, fetchScripts, fetchAccountsData } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function PluginsPage() {
  const [plugins, registry, credentialTypes, scripts, accountsData] = await Promise.all([
    fetchInstalledPlugins(),
    fetchRegistry(),
    fetchCredentialTypes(),
    fetchScripts(),
    fetchAccountsData(),
  ])
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Plugins</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Everything the engine knows comes from a plugin — browse what each one declares, or install more
        </p>
      </div>
      <PluginsClient
        initialPlugins={plugins}
        initialRegistry={registry}
        credentialTypes={credentialTypes}
        scripts={scripts}
        accountImpls={accountsData.implementations}
      />
    </div>
  )
}
