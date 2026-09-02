import { RetentionClient } from './RetentionClient'

export const dynamic = 'force-dynamic'

export default function MonitorRetentionPage() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Retention</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            Scheduled pruning for chosen monitor stores — nothing is trimmed until you name a target and a horizon
          </p>
        </div>
      </div>
      <RetentionClient />
    </div>
  )
}
