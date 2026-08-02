import { RegistryClient } from './RegistryClient'
import { fetchRegistry } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function RegistryPage() {
  const data = await fetchRegistry()
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Registry</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Registered monitors, strategies, and executors — import compiled TypeScript to add new ones
        </p>
      </div>
      <RegistryClient initialData={data} />
    </div>
  )
}
