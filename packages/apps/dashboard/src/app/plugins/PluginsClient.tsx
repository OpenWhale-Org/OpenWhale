'use client'

import { useMemo, useState, useEffect } from 'react'
import { Rail, RailItem } from '@/components/Rail'
import { useRouter } from 'next/navigation'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition, CredentialTypeInfo, ScriptInfo, AccountImplementationInfo, PluginDependents } from '@openwhaleorg/core'
import type { InstalledPluginView, PluginUpdate } from '@/lib/data'
import { Markdown } from '@/components/Markdown'
import { TypeMark } from '@/components/TypeMark'

/**
 * Plugins + Registry, merged: a JetBrains-style manager. Left rail lists
 * plugins under Built-in / External tabs; the right pane shows the selected
 * plugin's README and everything it declares, grouped into color-coded card
 * grids that link to the page where each element lives.
 *
 * Compiled components (AI compiler output, manual imports) have no plugin —
 * they appear as one pseudo-entry under External, which also hosts the
 * compiled-component import form the old Registry page carried.
 */

interface RegistryData {
  monitors: MonitorDefinition[]
  executors: ExecutorDefinition[]
  strategies: StrategyDefinition[]
}

interface Props {
  initialPlugins: InstalledPluginView[]
  initialRegistry: RegistryData
  credentialTypes: CredentialTypeInfo[]
  scripts: ScriptInfo[]
  accountImpls: AccountImplementationInfo[]
}

const COMPILED_ID = '__compiled__'

/** A plugin's mark: its own logo/icon, else the first branded credential type it registers, else a letter chip. */
function pluginMark(plugin: InstalledPluginView, credentialTypes: CredentialTypeInfo[]): { logo?: string; icon?: string } {
  if (plugin.logo !== undefined || plugin.icon !== undefined) {
    return { ...(plugin.logo !== undefined ? { logo: plugin.logo } : {}), ...(plugin.icon !== undefined ? { icon: plugin.icon } : {}) }
  }
  const branded = plugin.credentialTypes
    .map(type => credentialTypes.find(t => t.type === type))
    .find(t => t !== undefined && (t.logo !== undefined || t.icon !== undefined))
  return branded ? { ...(branded.logo !== undefined ? { logo: branded.logo } : {}), ...(branded.icon !== undefined ? { icon: branded.icon } : {}) } : {}
}

/** One hue per element category — the borders that tell the grids apart. */
const CATEGORY_COLORS = {
  strategies: 'var(--accent)',
  monitors: 'var(--success)',
  executors: 'var(--warning)',
  accounts: '#4d89ff',
  credentials: '#ee86dc',
  scripts: '#ff9f6f',
  cells: '#8b8fa3',
} as const

export function PluginsClient({ initialPlugins, initialRegistry, credentialTypes, scripts, accountImpls }: Props) {
  const [plugins, setPlugins] = useState(initialPlugins)
  const [registry, setRegistry] = useState(initialRegistry)
  const [tab, setTab] = useState<'builtin' | 'external'>('builtin')
  const [selected, setSelected] = useState<string | null>(initialPlugins.find(p => !p.source)?.name ?? null)
  const [installing, setInstalling] = useState(false)
  /** name → newer registry version, from the update check (npm installs only). */
  const [updates, setUpdates] = useState<Record<string, PluginUpdate>>({})

  // The check asks npm once per installed package — a few seconds, so it runs
  // after the page is up rather than blocking it, and again after any change.
  async function checkUpdates() {
    try {
      const res = await fetch('/api/plugins/updates')
      if (res.ok) setUpdates(Object.fromEntries((await res.json() as PluginUpdate[]).map(u => [u.name, u])))
    } catch { /* offline registry: no badges, nothing else changes */ }
  }
  useEffect(() => { void checkUpdates() }, [])

  const builtins = plugins.filter(p => !p.source)
  const externals = plugins.filter(p => p.source)
  const compiled = useMemo(() => ({
    strategies: registry.strategies.filter(d => d.source === 'compiled'),
    monitors: registry.monitors.filter(d => d.source === 'compiled'),
    executors: registry.executors.filter(d => d.source === 'compiled'),
  }), [registry])
  const compiledCount = compiled.strategies.length + compiled.monitors.length + compiled.executors.length

  async function refresh() {
    const [pluginsRes, registryRes] = await Promise.all([fetch('/api/plugins'), fetch('/api/registry')])
    if (pluginsRes.ok) setPlugins(await pluginsRes.json() as InstalledPluginView[])
    if (registryRes.ok) setRegistry(await registryRes.json() as RegistryData)
    void checkUpdates()
  }

  function pick(tabKey: 'builtin' | 'external', name: string | null) {
    setTab(tabKey)
    setSelected(name)
    setInstalling(false)
  }

  const rail = tab === 'builtin' ? builtins : externals
  const externalEmpty = externals.length === 0 && compiledCount === 0
  const selectedPlugin = plugins.find(p => p.name === selected)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <button onClick={() => setInstalling(v => !v)} className={`btn ${installing ? 'btn-secondary' : 'btn-primary'}`}>
          {installing ? 'Cancel' : '+ Install Plugin'}
        </button>
      </div>

      <div className="flex gap-3" style={{ height: 'calc(100vh - 16rem)', minHeight: 460 }}>
        {/* ── rail ─────────────────────────────────────────────────────────── */}
        <Rail
          width="18rem"
          header={
            <div className="flex">
              {([['builtin', `Built-in (${builtins.length})`], ['external', `External (${externals.length + (compiledCount > 0 ? 1 : 0)})`]] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => pick(key, key === 'builtin' ? builtins[0]?.name ?? null : externals[0]?.name ?? (compiledCount > 0 ? COMPILED_ID : null))}
                  className="flex-1 px-3 py-2.5 text-xs font-medium"
                  style={{
                    color: tab === key ? 'var(--foreground)' : 'var(--muted)',
                    borderBottom: tab === key ? '2px solid var(--accent)' : '2px solid transparent',
                    marginBottom: '-1px',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          }
        >
          {rail.map(p => {
            const count = p.strategies.length + p.monitors.length + p.executors.length + p.accounts.length + p.credentialTypes.length + p.scripts.length + p.cells.length
            const mark = pluginMark(p, credentialTypes)
            return (
              <RailItem
                key={p.name}
                active={selected === p.name && !installing}
                onClick={() => pick(tab, p.name)}
                mark={<TypeMark logo={mark.logo} icon={mark.icon} label={p.name} size={26} />}
                title={<>{p.name}{p.loadError && <span className="ml-1.5 text-xs" style={{ color: 'var(--danger)' }} title={p.loadError}>⚠</span>}</>}
                subtitle={updates[p.name] ? <>v{p.version} <span style={{ color: 'var(--accent)' }}>→ v{updates[p.name]!.latest} available</span></> : `v${p.version}`}
                right={<span className="font-mono">{count}</span>}
              />
            )
          })}
          {tab === 'external' && compiledCount > 0 && (
            <RailItem
              active={selected === COMPILED_ID}
              onClick={() => pick('external', COMPILED_ID)}
              mark={<TypeMark icon="✦" label="AI Compiled" size={26} />}
              title="AI Compiled"
              subtitle="compiled components"
              right={<span className="font-mono">{compiledCount}</span>}
            />
          )}
          {tab === 'external' && externalEmpty && (
            <div className="px-4 py-10 text-center flex flex-col items-center gap-3">
              <p className="text-xs" style={{ color: 'var(--muted)' }}>No external plugins yet.</p>
              <button onClick={() => setInstalling(true)} className="btn btn-primary btn-sm">+ Install Plugin</button>
              <p className="text-[11px] opacity-60" style={{ color: 'var(--muted)' }}>Plugin marketplace — coming soon</p>
            </div>
          )}
        </Rail>

        {/* ── detail ───────────────────────────────────────────────────────── */}
        <div
          className="flex-1 min-w-0 flex flex-col rounded-lg overflow-hidden"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          {installing ? (
            <div className="overflow-y-auto scroll-hidden p-5">
              <InstallForm onSuccess={() => { setInstalling(false); setTab('external'); void refresh() }} />
            </div>
          ) : selected === COMPILED_ID ? (
            <CompiledPane compiled={compiled} onChanged={() => void refresh()} />
          ) : selectedPlugin ? (
            <PluginDetail
              plugin={selectedPlugin}
              update={updates[selectedPlugin.name]}
              registry={registry}
              credentialTypes={credentialTypes}
              scripts={scripts}
              accountImpls={accountImpls}
              onUninstalled={() => { setSelected(externals.find(p => p.name !== selectedPlugin.name)?.name ?? null); void refresh() }}
              onUpdated={() => void refresh()}
            />
          ) : (
            <div className="flex-1 grid place-items-center text-sm" style={{ color: 'var(--muted)' }}>Pick a plugin.</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Detail pane ───────────────────────────────────────────────────────────────

function PluginDetail({ plugin, update, registry, credentialTypes, scripts, accountImpls, onUninstalled, onUpdated }: {
  plugin: InstalledPluginView
  /** A newer registry version, when the update check found one. */
  update?: PluginUpdate | undefined
  registry: RegistryData
  credentialTypes: CredentialTypeInfo[]
  scripts: ScriptInfo[]
  accountImpls: AccountImplementationInfo[]
  onUninstalled: () => void
  onUpdated: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [updateNote, setUpdateNote] = useState('')
  const [error, setError] = useState('')

  async function runUpdate() {
    if (!update) return
    setUpdating(true)
    setError('')
    setUpdateNote('')
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(plugin.name)}/update`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: update.latest }),
      })
      if (!res.ok) { setError(await res.text() || `Update failed (HTTP ${res.status})`); return }
      const out = await res.json() as { reloaded: string[]; reactivated: string[] }
      const bits = [`updated to v${update.latest}`]
      if (out.reloaded.length) bits.push(`reloaded ${out.reloaded.join(', ')}`)
      if (out.reactivated.length) bits.push(`re-activated ${out.reactivated.length} instance${out.reactivated.length === 1 ? '' : 's'}`)
      setUpdateNote(bits.join(' · '))
      onUpdated()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setUpdating(false)
    }
  }
  /* Asked before confirming, not after: the gateway would refuse anyway, but
     "you cannot, because these three instances use it" is worth knowing while
     the choice is still open — and so is the fact that confirming deletes
     monitor instances. */
  const [deps, setDeps] = useState<PluginDependents | null>(null)
  const [checking, setChecking] = useState(false)

  async function askConfirm() {
    setConfirming(true)
    setError('')
    setDeps(null)
    setChecking(true)
    try {
      const res = await fetch(`/api/plugins/${encodeURIComponent(plugin.name)}/dependents`)
      if (res.ok) setDeps(await res.json() as PluginDependents)
    } catch { /* the DELETE re-checks server-side — this is only the early warning */ }
    setChecking(false)
  }

  const blockers: Array<[string, string[]]> = deps
    ? ([['strategy instances', deps.instances], ['accounts', deps.accounts], ['credentials', deps.credentials]] as Array<[string, string[]]>)
        .filter(([, ids]) => ids.length > 0)
    : []

  const owns = (def: { id: string; pluginName?: string }, ids: string[]) =>
    def.pluginName === plugin.name || ids.includes(def.id)
  const strategies = registry.strategies.filter(d => owns(d, plugin.strategies))
  const monitors = registry.monitors.filter(d => owns(d, plugin.monitors))
  const executors = registry.executors.filter(d => owns(d, plugin.executors))
  const myAccounts = accountImpls.filter(a => a.pluginName === plugin.name || plugin.accounts.includes(a.id))
  const myCredTypes = credentialTypes.filter(t => plugin.credentialTypes.includes(t.type))
  const myScripts = scripts.filter(s => s.pluginName === plugin.name || plugin.scripts.includes(s.id))

  async function uninstall() {
    setRemoving(true)
    setError('')
    const res = await fetch(`/api/plugins/${encodeURIComponent(plugin.name)}`, { method: 'DELETE' })
    setRemoving(false)
    if (res.ok) { setConfirming(false); setDeps(null); onUninstalled() }
    else { setConfirming(false); setError(await res.text() || `Uninstall failed (HTTP ${res.status})`) }
  }

  const sourceBadge = !plugin.source ? 'built-in'
    : plugin.source.kind === 'npm' ? `npm: ${plugin.source.package}`
    : plugin.source.kind === 'github' ? `github: ${plugin.source.repo}${plugin.source.ref ? `#${plugin.source.ref}` : ''}`
    : plugin.source.kind === 'local' ? `local: ${plugin.source.path}`
    : `file: ${plugin.source.originalName}`
  /* The repo is the one source you can go and look at before trusting it —
     link it, since the badge already carries the address. */
  const sourceHref = plugin.source?.kind === 'github'
    ? `https://github.com/${plugin.source.repo}${plugin.source.ref ? `/tree/${plugin.source.ref}` : ''}`
    : null

  return (
    <>
      <div className="px-4 py-3 shrink-0 flex items-start justify-between gap-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          <TypeMark logo={pluginMark(plugin, credentialTypes).logo} icon={pluginMark(plugin, credentialTypes).icon} label={plugin.name} size={26} />
          <span className="text-base font-medium">{plugin.name}</span>
          {/* Installed under a namespace that is not its own name — say whose
              plugin this actually is, or the rail is a list of aliases. */}
          {plugin.declaredName && (
            <span className="badge badge-neutral" title={`The package calls itself "${plugin.declaredName}"`}>
              declared: {plugin.declaredName}
            </span>
          )}
          <span className="badge badge-neutral">v{plugin.version}</span>
          {sourceHref ? (
            <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="badge badge-neutral truncate max-w-[24rem] hover:underline" title={sourceHref}>{sourceBadge}</a>
          ) : (
            <span className="badge badge-neutral truncate max-w-[24rem]" title={sourceBadge}>{sourceBadge}</span>
          )}
          {plugin.installedAt && <span className="text-[11px]" style={{ color: 'var(--muted)' }}>installed {new Date(plugin.installedAt).toLocaleString()}</span>}
        </div>
        {plugin.source && (
          <div className="shrink-0 flex gap-2">
            {update && !confirming && (
              <button
                onClick={() => void runUpdate()}
                disabled={updating}
                className="btn btn-sm btn-primary"
                title={`Installed v${update.installed}; v${update.latest} is on npm. Updates in place, reloads dependent plugins and re-activates running instances.`}
              >
                {updating ? 'Updating…' : `↑ Update to v${update.latest}`}
              </button>
            )}
            {confirming ? (
              <>
                <button onClick={() => setConfirming(false)} className="btn btn-sm btn-secondary">Cancel</button>
                <button
                  onClick={() => void uninstall()}
                  disabled={removing || checking || blockers.length > 0}
                  className="btn btn-sm btn-danger-solid"
                >
                  {removing ? 'Removing…' : checking ? 'Checking…' : 'Confirm'}
                </button>
              </>
            ) : (
              <button onClick={() => void askConfirm()} className="btn btn-sm btn-danger">Uninstall</button>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden p-4 flex flex-col gap-5">
        {plugin.loadError && <p className="alert alert-danger text-xs">{plugin.loadError}</p>}
        {error && <p className="alert alert-danger text-xs">{error}</p>}
        {updateNote && <p className="alert alert-success text-xs">{updateNote}</p>}

        {confirming && (
          <div className={`alert text-xs flex flex-col gap-1.5 ${blockers.length > 0 ? 'alert-danger' : 'alert-warning'}`}>
            {checking ? (
              <span>Checking what depends on {plugin.name}…</span>
            ) : blockers.length > 0 ? (
              <>
                <span className="font-medium">Cannot uninstall — {plugin.name} is still in use:</span>
                {blockers.map(([label, ids]) => (
                  <span key={label}>
                    <span className="opacity-70">{ids.length} {label}: </span>
                    <span className="font-mono">{ids.slice(0, 6).join(', ')}{ids.length > 6 ? ` and ${ids.length - 6} more` : ''}</span>
                  </span>
                ))}
                {/* Each of these holds something the user configured — params,
                    a key, an equity history. Removing them is their call. */}
                <span className="opacity-70">Delete them first. Uninstalling would leave each one pointing at code that no longer exists.</span>
              </>
            ) : (
              <>
                <span className="font-medium">Uninstall {plugin.name}?</span>
                {deps && deps.monitorInstances.length > 0 && (
                  <span>
                    <span className="opacity-70">{deps.monitorInstances.length} monitor instance(s) will be deleted with it: </span>
                    <span className="font-mono">{deps.monitorInstances.slice(0, 6).join(', ')}{deps.monitorInstances.length > 6 ? ` and ${deps.monitorInstances.length - 6} more` : ''}</span>
                  </span>
                )}
              </>
            )}
          </div>
        )}

        {plugin.readme ? (
          <div className="rounded-md p-4" style={{ border: '1px solid var(--border)', background: 'color-mix(in srgb, var(--border) 12%, transparent)' }}>
            <Markdown source={plugin.readme} />
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--muted)' }}>This plugin ships no README.</p>
        )}

        <ElementGrid
          title="Strategies"
          color={CATEGORY_COLORS.strategies}
          href={(id) => `/instances?new=${encodeURIComponent(id)}`}
          items={strategies.map(d => ({ id: d.id, name: d.name, description: d.description }))}
        />
        <ElementGrid
          title="Monitors"
          color={CATEGORY_COLORS.monitors}
          href={(id) => `/monitor?sel=${encodeURIComponent(id)}`}
          items={monitors.map(d => ({ id: d.id, name: d.name, description: d.description }))}
        />
        <ElementGrid
          title="Executors"
          color={CATEGORY_COLORS.executors}
          href={() => '/executors'}
          items={executors.map(d => ({ id: d.id, name: d.name, description: d.description ?? d.supportedActions?.join(' · ') }))}
        />
        <ElementGrid
          title="Accounts"
          color={CATEGORY_COLORS.accounts}
          href={() => '/accounts'}
          items={myAccounts.map(a => ({
            id: a.id,
            name: a.displayName ?? a.id,
            description: `${a.kind}${a.type ? ` · venue ${a.type}` : ' · any venue'}${a.credentialTypes ? ` · keys: ${a.credentialTypes.join(', ')}` : ''}`,
          }))}
        />
        <ElementGrid
          title="Credential Types"
          color={CATEGORY_COLORS.credentials}
          href={() => '/credentials'}
          items={myCredTypes.map(t => ({ id: t.type, name: t.displayName ?? t.type, description: t.description, logo: t.logo, icon: t.icon }))}
        />
        <ElementGrid
          title="Adapter Cells"
          color={CATEGORY_COLORS.cells}
          items={plugin.cells.map(c => ({ id: `${c.kind} × ${c.venue}`, name: `${c.kind} × ${c.venue}` }))}
          compact
        />
        <ElementGrid
          title="Scripts"
          color={CATEGORY_COLORS.scripts}
          href={() => '/scripts'}
          items={myScripts.map(s => ({ id: s.id, name: s.name, description: s.description }))}
        />
      </div>
    </>
  )
}

function ElementGrid({ title, color, items, href, compact, onDelete }: {
  title: string
  color: string
  items: Array<{ id: string; name: string; description?: string | undefined; logo?: string | undefined; icon?: string | undefined }>
  /** Where an item's corner jump button navigates; absent = no button (e.g. adapter cells). */
  href?: (id: string) => string
  compact?: boolean
  /** Two-step delete on each card (compiled components only). */
  onDelete?: (id: string) => Promise<void>
}) {
  const router = useRouter()
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        <span className="inline-block w-2 h-2 rounded-full" style={{ background: color }} />
        {title}
        <span className="opacity-60 font-normal">({items.length})</span>
      </div>
      <div className={`grid gap-2 ${compact ? 'grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]'}`}>
        {items.map(item => (
          <div
            key={item.id}
            className="relative rounded-md px-3 py-2 min-w-0"
            style={{
              background: `color-mix(in srgb, ${color} 6%, transparent)`,
              border: `1px solid color-mix(in srgb, ${color} 30%, var(--border))`,
              borderLeft: `3px solid ${color}`,
            }}
          >
            {/* Deliberately corner buttons, not a clickable card — a card this
                dense gets clicked while reading, and a mis-tap navigates away. */}
            {onDelete && (
              <button
                onClick={() => {
                  if (pendingDelete !== item.id) { setPendingDelete(item.id); return }
                  setPendingDelete(null)
                  void onDelete(item.id)
                }}
                onMouseLeave={() => { if (pendingDelete === item.id) setPendingDelete(null) }}
                title={pendingDelete === item.id ? 'Click again to delete permanently' : 'Delete compiled component'}
                aria-label={`Delete ${item.name}`}
                className="absolute top-1.5 grid place-items-center w-6 h-6 rounded-md text-[11px]"
                style={{
                  right: href ? '2rem' : '0.375rem',
                  color: pendingDelete === item.id ? '#fff' : 'var(--muted)',
                  background: pendingDelete === item.id ? 'var(--danger)' : 'transparent',
                  border: '1px solid transparent',
                }}
              >
                {pendingDelete === item.id ? '✓' : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14" />
                  </svg>
                )}
              </button>
            )}
            {href && (
              <button
                onClick={() => router.push(href(item.id))}
                title={`Open in ${title}`}
                aria-label={`Open ${item.name}`}
                className="absolute top-1.5 right-1.5 grid place-items-center w-6 h-6 rounded-md"
                style={{ color: 'var(--muted)', border: '1px solid transparent' }}
                onMouseEnter={(e) => { e.currentTarget.style.color = color; e.currentTarget.style.borderColor = `color-mix(in srgb, ${color} 45%, transparent)` }}
                onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.borderColor = 'transparent' }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 17L17 7M9 7h8v8" />
                </svg>
              </button>
            )}
            <div className="flex items-start gap-2 min-w-0" style={href || onDelete ? { paddingRight: href && onDelete ? '3.25rem' : '1.5rem' } : undefined}>
              {(item.logo !== undefined || item.icon !== undefined) && (
                <TypeMark logo={item.logo} icon={item.icon} label={item.name} size={22} />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate" title={item.name}>{item.name}</div>
                {item.id !== item.name && (
                  <div className="text-[11px] font-mono truncate" style={{ color: 'var(--muted)' }} title={item.id}>{item.id}</div>
                )}
                {item.description && (
                  <div className="text-xs mt-1 line-clamp-2" style={{ color: 'var(--muted)' }} title={item.description}>
                    {item.description}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Compiled pseudo-plugin pane (the old Registry page's surviving duty) ─────

function CompiledPane({ compiled, onChanged }: {
  compiled: { strategies: StrategyDefinition[]; monitors: MonitorDefinition[]; executors: ExecutorDefinition[] }
  onChanged: () => void
}) {
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')

  const deleteComponent = (type: 'strategies' | 'monitors' | 'executors') => async (id: string) => {
    setError('')
    const res = await fetch(`/api/registry/${type}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Delete failed (HTTP ${res.status})`)
    else onChanged()
  }
  return (
    <>
      <div className="px-4 py-3 shrink-0 flex items-center justify-between gap-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <span className="text-base font-medium">AI Compiled</span>
          <span className="badge badge-neutral">compiled components</span>
        </div>
        <button onClick={() => setImporting(v => !v)} className={`btn btn-sm ${importing ? 'btn-secondary' : 'btn-primary'}`}>
          {importing ? 'Cancel' : '+ Import Component'}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden p-4 flex flex-col gap-5">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          Components registered outside any plugin — the AI compiler&apos;s approved output, and manual compiled imports.
        </p>
        {error && <p className="alert alert-danger text-xs">{error}</p>}
        {importing && <ImportForm onSuccess={() => { setImporting(false); onChanged() }} />}
        <ElementGrid title="Strategies" color={CATEGORY_COLORS.strategies} href={(id) => `/instances?new=${encodeURIComponent(id)}`} onDelete={deleteComponent('strategies')} items={compiled.strategies.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
        <ElementGrid title="Monitors" color={CATEGORY_COLORS.monitors} href={(id) => `/monitor?sel=${encodeURIComponent(id)}`} onDelete={deleteComponent('monitors')} items={compiled.monitors.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
        <ElementGrid title="Executors" color={CATEGORY_COLORS.executors} href={() => '/executors'} onDelete={deleteComponent('executors')} items={compiled.executors.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
      </div>
    </>
  )
}

function ImportForm({ onSuccess }: { onSuccess: () => void }) {
  const [type, setType] = useState<'strategies' | 'monitors' | 'executors'>('strategies')
  const [id, setId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return
    setError('')
    setSubmitting(true)
    const fd = new FormData()
    fd.append('type', type)
    fd.append('id', id.trim())
    fd.append('file', file)
    const res = await fetch('/api/registry', { method: 'POST', body: fd })
    if (res.ok) onSuccess()
    else setError(((await res.json()) as { error?: string }).error ?? 'Import failed')
    setSubmitting(false)
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-md p-4 flex flex-col gap-3" style={{ border: '1px solid var(--border)' }}>
      <div className="flex gap-2">
        {(['strategies', 'monitors', 'executors'] as const).map(t => (
          <button key={t} type="button" onClick={() => setType(t)} className={`btn btn-sm capitalize ${type === t ? 'btn-primary' : 'btn-secondary'}`}>{t}</button>
        ))}
      </div>
      <input
        value={id}
        onChange={(e) => setId(e.target.value)}
        required
        pattern="[A-Za-z0-9-_]+"
        placeholder="component id, e.g. btc-price-monitor"
        className="input font-mono"
      />
      <input type="file" accept=".ts,.js,.mjs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-muted" />
      {error && <p className="alert alert-danger text-xs">{error}</p>}
      <button type="submit" disabled={submitting || !file || !id.trim()} className="btn btn-primary btn-sm self-end">
        {submitting ? 'Importing…' : 'Import'}
      </button>
    </form>
  )
}

// ── Install form: bundle file, GitHub repo, or npm package ───────────────────

const MODES = [
  ['npm', 'From npm'],
  ['github', 'From GitHub'],
  ['file', 'From file'],
] as const

const MODE_HINT: Record<(typeof MODES)[number][0], string> = {
  npm: 'Recommended for the manual routes — published packages install with their dependencies and get the one-click Update button when a newer version appears (e.g. @openwhaleorg/pendle). A local absolute path works too.',
  github: 'For a repository that is not on npm yet: the gateway clones and builds it, which takes a few minutes and needs the build toolchain on the server.',
  file: 'A single pre-built bundle you upload by hand — for trying a plugin before it has a package or a repo.',
}

type Conflict = {
  plugin: string
  /** True when the incoming package is the same artefact — a new version. */
  sameSource: boolean
  suggestedAlias: string
  /** Non-namespaced registrations another plugin holds; non-empty = coexistence is impossible. */
  blockedBy?: Array<{ what: string; name: string; owner: string }>
  source?: string
  installedAt?: string
}
type ReplaceOutcome = { plugin: string; resumed: string[]; orphaned: string[] }

function InstallForm({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<'npm' | 'github' | 'file'>('npm')
  const [pkg, setPkg] = useState('')
  const [repo, setRepo] = useState('')
  const [ref, setRef] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [config, setConfig] = useState('{}')
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)
  /* The same plugin arriving from a second source is a question, not a
     failure — the engine says what it collided with and waits to be told. */
  const [conflict, setConflict] = useState<Conflict | null>(null)
  /* The namespace to install a same-named-but-different plugin under. Every id
     it registers is built from this, and instances persist those ids, so it is
     chosen once here and never again. */
  const [alias, setAlias] = useState('')
  /* A replacement is the one install worth reporting instead of just closing:
     it may have left instances behind that the new version cannot run. */
  const [outcome, setOutcome] = useState<ReplaceOutcome | null>(null)

  async function post(overwrite: boolean, as: string, parsedConfig: unknown): Promise<Response> {
    if (mode === 'npm' || mode === 'github') {
      const common = { config: parsedConfig, overwrite, ...(as ? { alias: as } : {}) }
      return fetch('/api/plugins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'npm'
          ? { source: 'npm', package: pkg.trim(), ...common }
          : { source: 'github', repo: repo.trim(), ref: ref.trim(), ...common }),
      })
    }
    const form = new FormData()
    form.set('file', file!)
    form.set('config', JSON.stringify(parsedConfig))
    if (overwrite) form.set('overwrite', 'true')
    if (as) form.set('alias', as)
    return fetch('/api/plugins', { method: 'POST', body: form })
  }

  async function run(overwrite: boolean, as = '') {
    setError('')
    setConflict(null)
    let parsedConfig: unknown
    try {
      parsedConfig = config.trim() === '' ? {} : JSON.parse(config)
    } catch {
      setError('Config must be valid JSON')
      return
    }
    if (mode === 'file' && !file) { setError('Choose a .js/.mjs bundle file'); return }
    setInstalling(true)
    try {
      const res = await post(overwrite, as, parsedConfig)
      if (res.status === 409) {
        const body = await res.json() as { conflict?: Conflict; error?: string }
        if (body.conflict) {
          setConflict(body.conflict)
          setAlias(body.conflict.suggestedAlias)
        } else setError(body.error ?? 'Install failed')
        return
      }
      if (!res.ok) {
        setError(await res.text() || `Install failed (HTTP ${res.status})`)
        return
      }
      const view = await res.json() as InstalledPluginView & { replace?: { replaced: boolean; resumed: string[]; orphaned: string[] } }
      if (view.replace?.replaced) setOutcome({ plugin: view.name, resumed: view.replace.resumed, orphaned: view.replace.orphaned })
      else onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setInstalling(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    void run(false)
  }

  if (outcome) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="font-semibold text-base">{outcome.plugin} replaced</h2>
        <p className="alert alert-success text-xs">
          {outcome.resumed.length > 0
            ? `${outcome.resumed.length} instance(s) were running on the old code and are running again.`
            : 'Nothing was running on the old code.'}
        </p>
        {outcome.orphaned.length > 0 && (
          <div className="alert alert-warning text-xs flex flex-col gap-1.5">
            <span className="font-medium">{outcome.orphaned.length} instance(s) could not restart — the new version does not provide their strategy:</span>
            <span className="font-mono">{outcome.orphaned.join(', ')}</span>
            {/* Nothing was deleted, which is the point: they are on the
                Instances page marked broken, to remove or to bring back by
                reinstalling the version that had the strategy. */}
            <span className="opacity-70">
              Nothing was deleted. They are on the Instances page marked broken — delete them there, or reinstall the
              version that has the strategy and they come back.
            </span>
          </div>
        )}
        <button type="button" onClick={onSuccess} className="btn btn-primary self-end">Done</button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h2 className="font-semibold text-base">Install Plugin</h2>
      {/* The hands-off path first: the Assistant knows the registry, picks the
          package, installs it and walks through credentials and accounts. The
          tabs below are the manual routes. */}
      <a
        href="/assistant"
        className="flex items-start gap-3 rounded-md px-3 py-2.5 hoverable"
        style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }}
      >
        <span aria-hidden className="text-base leading-none mt-0.5">✨</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Recommended: install from AI</span>
          <span className="block text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            Tell the Assistant what you want to trade or which plugin you mean — it finds the package, installs it and sets up the credentials and accounts with you. The tabs below are the manual way.
          </span>
        </span>
        <span className="text-xs shrink-0 mt-1" style={{ color: 'var(--accent)' }}>Open Assistant →</span>
      </a>
      <div className="flex gap-2 items-center flex-wrap">
        {MODES.map(([m, label]) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-secondary'}`}>
            {label}
            {m === 'npm' && <span className="ml-1.5 text-[10px] px-1 rounded" style={{ background: 'color-mix(in srgb, var(--success, #22c55e) 18%, transparent)', color: 'var(--success, #22c55e)' }}>recommended</span>}
          </button>
        ))}
      </div>
      <p className="text-xs -mt-2" style={{ color: 'var(--muted)' }}>{MODE_HINT[mode]}</p>
      {mode === 'npm' ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">
            Package name or local path <span className="text-danger">*</span>
            <span className="ml-1 opacity-60">— @scope/pkg, name@1.2.0, or an absolute directory like /Users/me/my-plugin (must be built)</span>
          </label>
          <input value={pkg} onChange={(e) => setPkg(e.target.value)} required placeholder="@scope/package-name or /abs/path/to/package" className="input font-mono" />
        </div>
      ) : mode === 'github' ? (
        /* Two fields, not one: the URL people paste already carries a branch
           (…/tree/main), so the ref box stays optional and simply wins when
           filled — nobody should have to edit a URL to change a branch. */
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">
              Repository <span className="text-danger">*</span>
              <span className="ml-1 opacity-60">— owner/repo, or paste the address bar: https://github.com/owner/repo</span>
            </label>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} required placeholder="OpenWhale-Org/OpenWhale" className="input font-mono" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">
              Branch, tag or commit
              <span className="ml-1 opacity-60">— optional; defaults to the repo&apos;s default branch</span>
            </label>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main / v1.2.0 / 4f3a91c" className="input font-mono" />
          </div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            The repo is cloned and built by npm — a source-only repo needs a <code className="font-mono">prepare</code> script in its
            package.json. Private repos need <code className="font-mono">OPENWHALE_GITHUB_TOKEN</code> set on the engine.
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">
            Plugin bundle <span className="text-danger">*</span>
            <span className="ml-1 opacity-60">— built ESM .js/.mjs, default-exporting a plugin factory</span>
          </label>
          <input type="file" accept=".js,.mjs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-muted" />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted">Config (JSON) — passed to the plugin factory</label>
        <textarea value={config} onChange={(e) => setConfig(e.target.value)} rows={3} spellCheck={false} placeholder='{ "testnet": true }' className="input font-mono resize-y" />
      </div>
      <p className="alert alert-warning text-xs">
        ⚠️ Installing a plugin runs third-party code inside the engine process with full access to credentials and accounts. Only install packages you trust.
      </p>
      {error && <p className="alert alert-danger whitespace-pre-wrap">{error}</p>}
      {conflict && (
        /* Two very different situations wear the same collision, and the
           source tells them apart. Same package = a new version of what is
           installed, so overwrite is the answer. Different package = two
           authors who both called their plugin `funding-arb`, and the right
           answer is a namespace of its own — overwriting there would replace a
           stranger's plugin with this one and take its strategies with it. */
        <div className="alert alert-warning text-xs flex flex-col gap-2">
          {conflict.sameSource ? (
            <>
              <span className="font-medium">
                <span className="font-mono">{conflict.plugin}</span> is already installed from this same source
                {conflict.source && <> (<span className="font-mono">{conflict.source}</span>)</>}
                {conflict.installedAt && <span className="opacity-70"> — {new Date(conflict.installedAt).toLocaleString()}</span>}.
              </span>
              <span className="opacity-70">
                Overwriting replaces its code. Instances, accounts and credentials are kept — anything running restarts on
                the new code, and anything whose strategy the new version dropped is left marked broken rather than deleted.
              </span>
            </>
          ) : conflict.blockedBy && conflict.blockedBy.length > 0 ? (
            /* A different plugin of the same name, but the two claim something
               that is not namespaced — a venue's adapter cell, a credential
               type. No namespace can separate those, so the honest answer is
               that only one of them can be installed, and the choice is which. */
            <>
              <span className="font-medium">
                These two cannot both be installed. This package and the one installed as{' '}
                <span className="font-mono">{conflict.plugin}</span> both provide:
              </span>
              <ul className="flex flex-col gap-0.5 pl-4 list-disc">
                {conflict.blockedBy.map(c => (
                  <li key={`${c.what}:${c.name}`}>
                    {c.what} <span className="font-mono">{c.name}</span>
                    <span className="opacity-70"> — held by <span className="font-mono">{c.owner}</span></span>
                  </li>
                ))}
              </ul>
              <span className="opacity-70">
                Those are addressed without a plugin name — that is how an account finds its venue — so exactly one plugin
                can provide each, and a separate namespace would not change it. Overwrite the installed one if this is
                meant to take its place, or uninstall it first.
              </span>
            </>
          ) : (
            <>
              <span className="font-medium">
                The namespace <span className="font-mono">{conflict.plugin}</span> is taken
                {conflict.source && <> by an install from <span className="font-mono">{conflict.source}</span></>}.
              </span>
              <span className="opacity-70">
                This package came from somewhere else, so it is a different plugin that happens to share a name. Give it a
                namespace of its own — its strategies, monitors and accounts will be named after it
                (<span className="font-mono">{alias || conflict.suggestedAlias}/…</span>), and it cannot be changed later
                because instances are saved under those ids.
              </span>
              <label className="flex flex-col gap-1 mt-0.5">
                <span className="opacity-70">Install as</span>
                <input
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  pattern="[A-Za-z0-9][\w.-]*"
                  className="input font-mono"
                  placeholder={conflict.suggestedAlias}
                />
              </label>
            </>
          )}
        </div>
      )}
      <div className="flex gap-2 self-end">
        {conflict && !conflict.sameSource && !(conflict.blockedBy && conflict.blockedBy.length > 0) && (
          <button
            type="button"
            onClick={() => void run(false, alias.trim() || conflict.suggestedAlias)}
            disabled={installing}
            className="btn btn-primary"
          >
            {installing ? 'Installing…' : `Install as ${alias.trim() || conflict.suggestedAlias}`}
          </button>
        )}
        {conflict && (
          <button
            type="button"
            onClick={() => void run(true)}
            disabled={installing}
            className={`btn ${conflict.sameSource || conflict.blockedBy?.length ? 'btn-danger-solid' : 'btn-danger'}`}
            title={conflict.sameSource ? undefined : 'Replaces the installed plugin — its strategies stop being available'}
          >
            {installing ? 'Overwriting…' : `Overwrite ${conflict.plugin}`}
          </button>
        )}
        <button
          type="submit"
          disabled={installing || (mode === 'npm' ? !pkg.trim() : mode === 'github' ? !repo.trim() : !file)}
          className={`btn ${conflict ? 'btn-secondary' : 'btn-primary'}`}
        >
          {installing && !conflict
            ? mode === 'github' ? 'Cloning and building… (may take a few minutes)' : 'Installing… (npm may take a minute)'
            : conflict ? 'Retry' : 'Install'}
        </button>
      </div>
    </form>
  )
}
