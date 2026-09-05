import { PluginsClient } from './PluginsClient'
import { fetchInstalledPlugins, fetchRegistry, fetchCredentialTypes, fetchScripts, fetchAccountsData } from '@/lib/data'
import { serverT } from '@/i18n/server'

export const dynamic = 'force-dynamic'

export default async function PluginsPage() {
  const [plugins, registry, credentialTypes, scripts, accountsData, t] = await Promise.all([
    fetchInstalledPlugins(),
    fetchRegistry(),
    fetchCredentialTypes(),
    fetchScripts(),
    fetchAccountsData(),
    serverT(),
  ])
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{t('plugins.title')}</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          {t('plugins.subtitle')}
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
