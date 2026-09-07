import { serverT } from '@/i18n/server'

export default async function AssistantPage() {
  const t = await serverT()
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{t('assistant.title')}</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          {t('assistant.tagline')}
        </p>
      </div>
      <div
        className="flex flex-col items-center justify-center rounded-lg border py-24 text-center"
        style={{ borderColor: 'var(--border)' }}
      >
        <span className="text-4xl mb-4">🚧</span>
        <p className="text-lg font-medium">{t('assistant.comingSoon')}</p>
        <p className="text-sm mt-2" style={{ color: 'var(--muted)' }}>
          {t('assistant.underDevelopment')}
        </p>
      </div>
    </div>
  )
}
