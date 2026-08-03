import { PluginsClient } from './PluginsClient'
import { fetchInstalledPlugins } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function PluginsPage() {
  const plugins = await fetchInstalledPlugins()
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Plugins</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Install exchange and data-source plugins from npm or a built bundle file
        </p>
      </div>
      <PluginsClient initialPlugins={plugins} />
    </div>
  )
}
