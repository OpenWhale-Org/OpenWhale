import { RetentionClient } from './RetentionClient'
import { serverT } from '@/i18n/server'

export const dynamic = 'force-dynamic'

export default async function MonitorRetentionPage() {
  const t = await serverT()
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">{t('retention.title')}</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            {t('retention.description')}
          </p>
        </div>
      </div>
      <RetentionClient />
    </div>
  )
}
