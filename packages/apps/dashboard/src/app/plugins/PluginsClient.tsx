'use client'

import { useMemo, useState, useEffect } from 'react'
import { Rail, RailItem } from '@/components/Rail'
import { useRouter } from 'next/navigation'
import type { PluginDependents } from '@openwhaleorg/core'
import type { CredentialTypeInfo } from '@/lib/core-types'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition, ScriptInfo, AccountImplementationInfo } from '@/lib/core-types'
import type { InstalledPluginView, PluginUpdate } from '@/lib/data'
import { Markdown } from '@/components/Markdown'
import { TypeMark } from '@/components/TypeMark'
import { useT, type MessageKey } from '@/i18n'

/** Render a translated sentence whose `backticked` spans are code — a name, an env var — so the wording stays a sentence in every language. */
function rich(text: string): React.ReactNode {
  const parts = text.split('`')
  if (parts.length < 3) return text
  return parts.map((part, i) => i % 2 === 1 ? <span key={i} className="font-mono">{part}</span> : <span key={i}>{part}</span>)
}

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
  const t = useT()
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
          {installing ? t('common.cancel') : t('plugins.install')}
        </button>
      </div>

      <div className="flex gap-3" style={{ height: 'calc(100vh - 16rem)', minHeight: 460 }}>
        {/* ── rail ─────────────────────────────────────────────────────────── */}
        <Rail
          width="18rem"
          header={
            <div className="flex">
              {([['builtin', t('plugins.tab.builtin', { n: builtins.length })], ['external', t('plugins.tab.external', { n: externals.length + (compiledCount > 0 ? 1 : 0) })]] as const).map(([key, label]) => (
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
                subtitle={updates[p.name] ? <>v{p.version} <span style={{ color: 'var(--accent)' }}>{t('plugins.updateAvailable', { version: updates[p.name]!.latest })}</span></> : `v${p.version}`}
                right={<span className="font-mono">{count}</span>}
              />
            )
          })}
          {tab === 'external' && compiledCount > 0 && (
            <RailItem
              active={selected === COMPILED_ID}
              onClick={() => pick('external', COMPILED_ID)}
              mark={<TypeMark icon="✦" label={t('plugins.compiled')} size={26} />}
              title={t('plugins.compiled')}
              subtitle={t('plugins.compiledComponents')}
              right={<span className="font-mono">{compiledCount}</span>}
            />
          )}
          {tab === 'external' && externalEmpty && (
            <div className="px-4 py-10 text-center flex flex-col items-center gap-3">
              <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('plugins.noExternal')}</p>
              <button onClick={() => setInstalling(true)} className="btn btn-primary btn-sm">{t('plugins.install')}</button>
              <p className="text-[11px] opacity-60" style={{ color: 'var(--muted)' }}>{t('plugins.marketplaceSoon')}</p>
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
              <InstallForm
                onInstalled={() => { setTab('external'); void refresh() }}
                onSuccess={() => setInstalling(false)}
              />
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
            <div className="flex-1 grid place-items-center text-sm" style={{ color: 'var(--muted)' }}>{t('plugins.pickOne')}</div>
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
  const t = useT()
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
      if (!res.ok) { setError(await res.text() || t('plugins.updateFailed', { status: res.status })); return }
      const out = await res.json() as { reloaded: string[]; reactivated: string[] }
      const bits = [t('plugins.updatedTo', { version: update.latest })]
      if (out.reloaded.length) bits.push(t('plugins.reloaded', { names: out.reloaded.join(', ') }))
      if (out.reactivated.length) bits.push(t('plugins.reactivated', { n: out.reactivated.length }))
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
    ? ([[t('plugins.dep.instances'), deps.instances], [t('plugins.dep.accounts'), deps.accounts], [t('plugins.dep.credentials'), deps.credentials]] as Array<[string, string[]]>)
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
    else { setConfirming(false); setError(await res.text() || t('plugins.uninstallFailed', { status: res.status })) }
  }

  const sourceBadge = !plugin.source ? t('plugins.source.builtin')
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
            <span className="badge badge-neutral" title={t('plugins.declaredTitle', { name: plugin.declaredName })}>
              {t('plugins.declared', { name: plugin.declaredName })}
            </span>
          )}
          <span className="badge badge-neutral">v{plugin.version}</span>
          {sourceHref ? (
            <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="badge badge-neutral truncate max-w-[24rem] hover:underline" title={sourceHref}>{sourceBadge}</a>
          ) : (
            <span className="badge badge-neutral truncate max-w-[24rem]" title={sourceBadge}>{sourceBadge}</span>
          )}
          {plugin.installedAt && <span className="text-[11px]" style={{ color: 'var(--muted)' }}>{t('plugins.installedAt', { when: new Date(plugin.installedAt).toLocaleString() })}</span>}
        </div>
        {plugin.source && (
          <div className="shrink-0 flex gap-2">
            {update && !confirming && (
              <button
                onClick={() => void runUpdate()}
                disabled={updating}
                className="btn btn-sm btn-primary"
                title={t('plugins.updateTitle', { installed: update.installed, latest: update.latest })}
              >
                {updating ? t('plugins.updating') : t('plugins.updateTo', { version: update.latest })}
              </button>
            )}
            {confirming ? (
              <>
                <button onClick={() => setConfirming(false)} className="btn btn-sm btn-secondary">{t('common.cancel')}</button>
                <button
                  onClick={() => void uninstall()}
                  disabled={removing || checking || blockers.length > 0}
                  className="btn btn-sm btn-danger-solid"
                >
                  {removing ? t('plugins.removing') : checking ? t('plugins.checking') : t('common.confirm')}
                </button>
              </>
            ) : (
              <button onClick={() => void askConfirm()} className="btn btn-sm btn-danger">{t('plugins.uninstall')}</button>
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
              <span>{t('plugins.checkingDeps', { name: plugin.name })}</span>
            ) : blockers.length > 0 ? (
              <>
                <span className="font-medium">{t('plugins.cannotUninstall', { name: plugin.name })}</span>
                {blockers.map(([label, ids]) => (
                  <span key={label}>
                    <span className="opacity-70">{t('plugins.depCount', { n: ids.length, what: label })}</span>
                    <span className="font-mono">{ids.slice(0, 6).join(', ')}{ids.length > 6 ? t('plugins.andMore', { n: ids.length - 6 }) : ''}</span>
                  </span>
                ))}
                {/* Each of these holds something the user configured — params,
                    a key, an equity history. Removing them is their call. */}
                <span className="opacity-70">{t('plugins.deleteFirst')}</span>
              </>
            ) : (
              <>
                <span className="font-medium">{t('plugins.uninstallConfirm', { name: plugin.name })}</span>
                {deps && deps.monitorInstances.length > 0 && (
                  <span>
                    <span className="opacity-70">{t('plugins.monitorInstancesDeleted', { n: deps.monitorInstances.length })}</span>
                    <span className="font-mono">{deps.monitorInstances.slice(0, 6).join(', ')}{deps.monitorInstances.length > 6 ? t('plugins.andMore', { n: deps.monitorInstances.length - 6 }) : ''}</span>
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
          <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('plugins.noReadme')}</p>
        )}

        <ElementGrid
          title={t('plugins.grid.strategies')}
          color={CATEGORY_COLORS.strategies}
          href={(id) => `/instances?new=${encodeURIComponent(id)}`}
          items={strategies.map(d => ({ id: d.id, name: d.name, description: d.description }))}
        />
        <ElementGrid
          title={t('plugins.grid.monitors')}
          color={CATEGORY_COLORS.monitors}
          href={(id) => `/monitor?sel=${encodeURIComponent(id)}`}
          items={monitors.map(d => ({ id: d.id, name: d.name, description: d.description }))}
        />
        <ElementGrid
          title={t('plugins.grid.executors')}
          color={CATEGORY_COLORS.executors}
          href={() => '/executors'}
          items={executors.map(d => ({ id: d.id, name: d.name, description: d.description ?? d.supportedActions?.join(' · ') }))}
        />
        <ElementGrid
          title={t('plugins.grid.accounts')}
          color={CATEGORY_COLORS.accounts}
          href={() => '/accounts'}
          items={myAccounts.map(a => ({
            id: a.id,
            name: a.displayName ?? a.id,
            description: [
              a.kind,
              a.type ? t('plugins.account.venue', { venue: a.type }) : t('plugins.account.anyVenue'),
              ...(a.credentialTypes ? [t('plugins.account.keys', { types: a.credentialTypes.join(', ') })] : []),
            ].join(' · '),
          }))}
        />
        <ElementGrid
          title={t('plugins.grid.credentialTypes')}
          color={CATEGORY_COLORS.credentials}
          href={() => '/credentials'}
          items={myCredTypes.map(ct => ({ id: ct.type, name: ct.displayName ?? ct.type, description: ct.description, logo: ct.logo, icon: ct.icon }))}
        />
        <ElementGrid
          title={t('plugins.grid.cells')}
          color={CATEGORY_COLORS.cells}
          items={plugin.cells.map(c => ({ id: `${c.kind} × ${c.venue}`, name: `${c.kind} × ${c.venue}` }))}
          compact
        />
        <ElementGrid
          title={t('plugins.grid.scripts')}
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
  const t = useT()
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
                title={pendingDelete === item.id ? t('plugins.deleteAgain') : t('plugins.deleteCompiled')}
                aria-label={t('plugins.deleteItem', { name: item.name })}
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
                title={t('plugins.openIn', { title })}
                aria-label={t('plugins.openItem', { name: item.name })}
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
  const t = useT()
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')

  const deleteComponent = (type: 'strategies' | 'monitors' | 'executors') => async (id: string) => {
    setError('')
    const res = await fetch(`/api/registry/${type}/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? t('plugins.deleteFailed', { status: res.status }))
    else onChanged()
  }
  return (
    <>
      <div className="px-4 py-3 shrink-0 flex items-center justify-between gap-4" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-2">
          <span className="text-base font-medium">{t('plugins.compiled')}</span>
          <span className="badge badge-neutral">{t('plugins.compiledComponents')}</span>
        </div>
        <button onClick={() => setImporting(v => !v)} className={`btn btn-sm ${importing ? 'btn-secondary' : 'btn-primary'}`}>
          {importing ? t('common.cancel') : t('plugins.importComponent')}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden p-4 flex flex-col gap-5">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {t('plugins.compiledHint')}
        </p>
        {error && <p className="alert alert-danger text-xs">{error}</p>}
        {importing && <ImportForm onSuccess={() => { setImporting(false); onChanged() }} />}
        <ElementGrid title={t('plugins.grid.strategies')} color={CATEGORY_COLORS.strategies} href={(id) => `/instances?new=${encodeURIComponent(id)}`} onDelete={deleteComponent('strategies')} items={compiled.strategies.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
        <ElementGrid title={t('plugins.grid.monitors')} color={CATEGORY_COLORS.monitors} href={(id) => `/monitor?sel=${encodeURIComponent(id)}`} onDelete={deleteComponent('monitors')} items={compiled.monitors.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
        <ElementGrid title={t('plugins.grid.executors')} color={CATEGORY_COLORS.executors} href={() => '/executors'} onDelete={deleteComponent('executors')} items={compiled.executors.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
      </div>
    </>
  )
}

const COMPONENT_TYPE_LABEL: Record<'strategies' | 'monitors' | 'executors', MessageKey> = {
  strategies: 'plugins.grid.strategies',
  monitors: 'plugins.grid.monitors',
  executors: 'plugins.grid.executors',
}

function ImportForm({ onSuccess }: { onSuccess: () => void }) {
  const t = useT()
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
    else setError(((await res.json()) as { error?: string }).error ?? t('plugins.importFailed'))
    setSubmitting(false)
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-md p-4 flex flex-col gap-3" style={{ border: '1px solid var(--border)' }}>
      <div className="flex gap-2">
        {(['strategies', 'monitors', 'executors'] as const).map(kind => (
          <button key={kind} type="button" onClick={() => setType(kind)} className={`btn btn-sm ${type === kind ? 'btn-primary' : 'btn-secondary'}`}>{t(COMPONENT_TYPE_LABEL[kind])}</button>
        ))}
      </div>
      <input
        value={id}
        onChange={(e) => setId(e.target.value)}
        required
        pattern="[A-Za-z0-9-_]+"
        placeholder={t('plugins.componentIdPlaceholder')}
        className="input font-mono"
      />
      <input type="file" accept=".ts,.js,.mjs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-muted" />
      {error && <p className="alert alert-danger text-xs">{error}</p>}
      <button type="submit" disabled={submitting || !file || !id.trim()} className="btn btn-primary btn-sm self-end">
        {submitting ? t('plugins.importing') : t('common.import')}
      </button>
    </form>
  )
}

// ── Install form: bundle file, GitHub repo, or npm package ───────────────────

const MODES = [
  ['npm', 'plugins.mode.npm'],
  ['github', 'plugins.mode.github'],
  ['file', 'plugins.mode.file'],
] as const satisfies ReadonlyArray<readonly [string, MessageKey]>

const MODE_HINT: Record<(typeof MODES)[number][0], MessageKey> = {
  npm: 'plugins.modeHint.npm',
  github: 'plugins.modeHint.github',
  file: 'plugins.modeHint.file',
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

/*
 * `onInstalled` fires the moment the install lands; `onSuccess` closes the
 * form. They are the same instant on the plain path, but a replace holds the
 * form open on an outcome panel — and the list behind it is already stale by
 * then. Refreshing only on Done meant the plugin you just installed was
 * missing from the list for as long as you read what happened to it.
 */
function InstallForm({ onInstalled, onSuccess }: { onInstalled: () => void; onSuccess: () => void }) {
  const t = useT()
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
      setError(t('plugins.configInvalid'))
      return
    }
    if (mode === 'file' && !file) { setError(t('plugins.chooseBundle')); return }
    setInstalling(true)
    try {
      const res = await post(overwrite, as, parsedConfig)
      if (res.status === 409) {
        const body = await res.json() as { conflict?: Conflict; error?: string }
        if (body.conflict) {
          setConflict(body.conflict)
          setAlias(body.conflict.suggestedAlias)
        } else setError(body.error ?? t('plugins.installFailed'))
        return
      }
      if (!res.ok) {
        setError(await res.text() || t('plugins.installFailedHttp', { status: res.status }))
        return
      }
      const view = await res.json() as InstalledPluginView & { replace?: { replaced: boolean; resumed: string[]; orphaned: string[] } }
      onInstalled()
      if (view.replace?.replaced) setOutcome({ plugin: view.name, resumed: view.replace.resumed, orphaned: view.replace.orphaned })
      else onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('plugins.networkError'))
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
        <h2 className="font-semibold text-base">{t('plugins.replaced', { name: outcome.plugin })}</h2>
        <p className="alert alert-success text-xs">
          {outcome.resumed.length > 0
            ? t('plugins.resumed', { n: outcome.resumed.length })
            : t('plugins.nothingRunning')}
        </p>
        {outcome.orphaned.length > 0 && (
          <div className="alert alert-warning text-xs flex flex-col gap-1.5">
            <span className="font-medium">{t('plugins.orphaned', { n: outcome.orphaned.length })}</span>
            <span className="font-mono">{outcome.orphaned.join(', ')}</span>
            {/* Nothing was deleted, which is the point: they are on the
                Instances page marked broken, to remove or to bring back by
                reinstalling the version that had the strategy. */}
            <span className="opacity-70">
              {t('plugins.orphanedHint')}
            </span>
          </div>
        )}
        <button type="button" onClick={onSuccess} className="btn btn-primary self-end">{t('plugins.done')}</button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <h2 className="font-semibold text-base">{t('plugins.installTitle')}</h2>
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
          <span className="block text-sm font-medium">{t('plugins.aiRecommended')}</span>
          <span className="block text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            {t('plugins.aiHint')}
          </span>
        </span>
        <span className="text-xs shrink-0 mt-1" style={{ color: 'var(--accent)' }}>{t('plugins.openAssistant')}</span>
      </a>
      <div className="flex gap-2 items-center flex-wrap">
        {MODES.map(([m, label]) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-secondary'}`}>
            {t(label)}
            {m === 'npm' && <span className="ml-1.5 text-[10px] px-1 rounded" style={{ background: 'color-mix(in srgb, var(--success, #22c55e) 18%, transparent)', color: 'var(--success, #22c55e)' }}>{t('plugins.recommended')}</span>}
          </button>
        ))}
      </div>
      <p className="text-xs -mt-2" style={{ color: 'var(--muted)' }}>{t(MODE_HINT[mode])}</p>
      {mode === 'npm' ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">
            {t('plugins.npm.label')} <span className="text-danger">*</span>
            <span className="ml-1 opacity-60">{t('plugins.npm.hint')}</span>
          </label>
          <input value={pkg} onChange={(e) => setPkg(e.target.value)} required placeholder={t('plugins.npm.placeholder')} className="input font-mono" />
        </div>
      ) : mode === 'github' ? (
        /* Two fields, not one: the URL people paste already carries a branch
           (…/tree/main), so the ref box stays optional and simply wins when
           filled — nobody should have to edit a URL to change a branch. */
        <>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">
              {t('plugins.github.repo')} <span className="text-danger">*</span>
              <span className="ml-1 opacity-60">{t('plugins.github.repoHint')}</span>
            </label>
            <input value={repo} onChange={(e) => setRepo(e.target.value)} required placeholder="OpenWhale-Org/OpenWhale" className="input font-mono" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted">
              {t('plugins.github.ref')}
              <span className="ml-1 opacity-60">{t('plugins.github.refHint')}</span>
            </label>
            <input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="main / v1.2.0 / 4f3a91c" className="input font-mono" />
          </div>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            {rich(t('plugins.github.note'))}
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">
            {t('plugins.file.label')} <span className="text-danger">*</span>
            <span className="ml-1 opacity-60">{t('plugins.file.hint')}</span>
          </label>
          <input type="file" accept=".js,.mjs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-muted" />
        </div>
      )}
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted">{t('plugins.config')}</label>
        <textarea value={config} onChange={(e) => setConfig(e.target.value)} rows={3} spellCheck={false} placeholder='{ "testnet": true }' className="input font-mono resize-y" />
      </div>
      <p className="alert alert-warning text-xs">
        {t('plugins.trustWarning')}
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
                {rich(t('plugins.conflict.sameSource', { plugin: conflict.plugin }))}
                {conflict.source && <> (<span className="font-mono">{conflict.source}</span>)</>}
                {conflict.installedAt && <span className="opacity-70"> — {new Date(conflict.installedAt).toLocaleString()}</span>}
              </span>
              <span className="opacity-70">
                {t('plugins.conflict.overwriteHint')}
              </span>
            </>
          ) : conflict.blockedBy && conflict.blockedBy.length > 0 ? (
            /* A different plugin of the same name, but the two claim something
               that is not namespaced — a venue's adapter cell, a credential
               type. No namespace can separate those, so the honest answer is
               that only one of them can be installed, and the choice is which. */
            <>
              <span className="font-medium">
                {rich(t('plugins.conflict.blocked', { plugin: conflict.plugin }))}
              </span>
              <ul className="flex flex-col gap-0.5 pl-4 list-disc">
                {conflict.blockedBy.map(c => (
                  <li key={`${c.what}:${c.name}`}>
                    {c.what} <span className="font-mono">{c.name}</span>
                    <span className="opacity-70">{rich(t('plugins.conflict.heldBy', { owner: c.owner }))}</span>
                  </li>
                ))}
              </ul>
              <span className="opacity-70">
                {t('plugins.conflict.blockedHint')}
              </span>
            </>
          ) : (
            <>
              <span className="font-medium">
                {rich(conflict.source
                  ? t('plugins.conflict.takenBy', { plugin: conflict.plugin, source: conflict.source })
                  : t('plugins.conflict.taken', { plugin: conflict.plugin }))}
              </span>
              <span className="opacity-70">
                {rich(t('plugins.conflict.aliasHint', { alias: alias || conflict.suggestedAlias }))}
              </span>
              <label className="flex flex-col gap-1 mt-0.5">
                <span className="opacity-70">{t('plugins.installAs')}</span>
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
            {installing ? t('plugins.installing') : t('plugins.installAsName', { alias: alias.trim() || conflict.suggestedAlias })}
          </button>
        )}
        {conflict && (
          <button
            type="button"
            onClick={() => void run(true)}
            disabled={installing}
            className={`btn ${conflict.sameSource || conflict.blockedBy?.length ? 'btn-danger-solid' : 'btn-danger'}`}
            title={conflict.sameSource ? undefined : t('plugins.overwriteTitle')}
          >
            {installing ? t('plugins.overwriting') : t('plugins.overwrite', { plugin: conflict.plugin })}
          </button>
        )}
        <button
          type="submit"
          disabled={installing || (mode === 'npm' ? !pkg.trim() : mode === 'github' ? !repo.trim() : !file)}
          className={`btn ${conflict ? 'btn-secondary' : 'btn-primary'}`}
        >
          {installing && !conflict
            ? mode === 'github' ? t('plugins.cloning') : t('plugins.installingNpm')
            : conflict ? t('common.retry') : t('plugins.installBtn')}
        </button>
      </div>
    </form>
  )
}
