import { ExplorerClient } from './ExplorerClient'
import { serverT } from '@/i18n/server'

export const dynamic = 'force-dynamic'

export default async function MonitorDataPage() {
  const t = await serverT()
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">{t('explorer.title')}</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            {t('explorer.description')}
          </p>
        </div>
      </div>
      <ExplorerClient />
    </div>
  )
}
