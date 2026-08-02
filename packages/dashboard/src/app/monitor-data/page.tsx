import { ExplorerClient } from './ExplorerClient'

export const dynamic = 'force-dynamic'

export default function MonitorDataPage() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Monitor Explorer</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
            Browse every contract&apos;s persisted JSONL data — contract → key → records
          </p>
        </div>
      </div>
      <ExplorerClient />
    </div>
  )
}
