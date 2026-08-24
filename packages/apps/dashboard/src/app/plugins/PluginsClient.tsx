'use client'

import { useMemo, useRef, useState } from 'react'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition, CredentialTypeInfo, ScriptInfo, AccountImplementationInfo } from '@openwhaleorg/core'
import type { InstalledPluginView } from '@/lib/data'
import { Markdown } from '@/components/Markdown'

/**
 * Plugins + Registry, merged: a JetBrains-style manager. Left rail lists
 * plugins under Built-in / External tabs; the right pane shows the selected
 * plugin's README and everything it declares (strategies, monitors,
 * executors, accounts, credential types, adapter cells, scripts).
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

export function PluginsClient({ initialPlugins, initialRegistry, credentialTypes, scripts, accountImpls }: Props) {
  const [plugins, setPlugins] = useState(initialPlugins)
  const [registry, setRegistry] = useState(initialRegistry)
  const [tab, setTab] = useState<'builtin' | 'external'>('builtin')
  const [selected, setSelected] = useState<string | null>(initialPlugins.find(p => !p.source)?.name ?? null)
  const [installing, setInstalling] = useState(false)

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
  }

  function pick(tabKey: 'builtin' | 'external', name: string | null) {
    setTab(tabKey)
    setSelected(name)
    setInstalling(false)
  }

  const rail = tab === 'builtin' ? builtins : externals
  const selectedPlugin = plugins.find(p => p.name === selected)

  return (
    <div className="flex gap-4 items-start">
      {/* ── Left rail ── */}
      <div className="w-72 shrink-0 card overflow-hidden">
        <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
          {([['builtin', `Built-in (${builtins.length})`], ['external', `External (${externals.length + (compiledCount > 0 ? 1 : 0)})`]] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => pick(key, key === 'builtin' ? builtins[0]?.name ?? null : externals[0]?.name ?? (compiledCount > 0 ? COMPILED_ID : null))}
              className="flex-1 px-3 py-2 text-xs font-medium"
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

        <div className="flex flex-col max-h-[70vh] overflow-y-auto">
          {rail.map(p => (
            <PluginRailRow key={p.name} plugin={p} active={selected === p.name && !installing} onClick={() => pick(tab, p.name)} />
          ))}
          {tab === 'external' && compiledCount > 0 && (
            <button
              onClick={() => pick('external', COMPILED_ID)}
              className="text-left px-3 py-2.5 flex items-center gap-2"
              style={{ background: selected === COMPILED_ID ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent' }}
            >
              <span className="text-sm font-medium truncate">AI Compiled</span>
              <span className="badge badge-neutral ml-auto shrink-0">{compiledCount}</span>
            </button>
          )}
          {tab === 'external' && externals.length === 0 && compiledCount === 0 && (
            <div className="p-6 text-center flex flex-col items-center gap-3">
              <p className="text-xs" style={{ color: 'var(--muted)' }}>No external plugins yet.</p>
              <button onClick={() => setInstalling(true)} className="btn btn-primary btn-sm">+ Install Plugin</button>
              <p className="text-[11px] opacity-60" style={{ color: 'var(--muted)' }}>Plugin marketplace — coming soon</p>
            </div>
          )}
        </div>

        {(tab === 'builtin' || externals.length > 0 || compiledCount > 0) && (
          <div className="p-2" style={{ borderTop: '1px solid var(--border)' }}>
            <button onClick={() => setInstalling(v => !v)} className={`btn btn-sm w-full ${installing ? 'btn-secondary' : 'btn-primary'}`}>
              {installing ? 'Cancel' : '+ Install Plugin'}
            </button>
          </div>
        )}
      </div>

      {/* ── Right pane ── */}
      <div className="flex-1 min-w-0">
        {installing ? (
          <InstallForm onSuccess={() => { setInstalling(false); setTab('external'); void refresh() }} />
        ) : selected === COMPILED_ID ? (
          <CompiledPane compiled={compiled} onChanged={() => void refresh()} />
        ) : selectedPlugin ? (
          <PluginDetail
            plugin={selectedPlugin}
            registry={registry}
            credentialTypes={credentialTypes}
            scripts={scripts}
            accountImpls={accountImpls}
            onUninstalled={() => { setSelected(externals.find(p => p.name !== selectedPlugin.name)?.name ?? null); void refresh() }}
          />
        ) : (
          <div className="card p-10 text-center text-sm" style={{ color: 'var(--muted)' }}>Pick a plugin.</div>
        )}
      </div>
    </div>
  )
}

function PluginRailRow({ plugin, active, onClick }: { plugin: InstalledPluginView; active: boolean; onClick: () => void }) {
  const count = plugin.strategies.length + plugin.monitors.length + plugin.executors.length
    + plugin.accounts.length + plugin.credentialTypes.length + plugin.scripts.length + plugin.cells.length
  return (
    <button
      onClick={onClick}
      className="text-left px-3 py-2.5 flex items-center gap-2"
      style={{ background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent' }}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">
          {plugin.name}
          {plugin.loadError && <span className="ml-1.5 badge badge-danger">!</span>}
        </div>
        <div className="text-[11px]" style={{ color: 'var(--muted)' }}>v{plugin.version}</div>
      </div>
      <span className="badge badge-neutral ml-auto shrink-0">{count}</span>
    </button>
  )
}

// ── Detail pane ───────────────────────────────────────────────────────────────

function PluginDetail({ plugin, registry, credentialTypes, scripts, accountImpls, onUninstalled }: {
  plugin: InstalledPluginView
  registry: RegistryData
  credentialTypes: CredentialTypeInfo[]
  scripts: ScriptInfo[]
  accountImpls: AccountImplementationInfo[]
  onUninstalled: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [error, setError] = useState('')

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
    if (res.ok) onUninstalled()
    else { setConfirming(false); setError(await res.text() || `Uninstall failed (HTTP ${res.status})`) }
  }

  const sourceBadge = !plugin.source ? 'built-in'
    : plugin.source.kind === 'npm' ? `npm: ${plugin.source.package}`
    : plugin.source.kind === 'local' ? `local: ${plugin.source.path}`
    : `file: ${plugin.source.originalName}`

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-lg font-semibold">{plugin.name}</span>
          <span className="badge badge-neutral">v{plugin.version}</span>
          <span className="badge badge-neutral">{sourceBadge}</span>
          {plugin.installedAt && <span className="text-[11px]" style={{ color: 'var(--muted)' }}>installed {new Date(plugin.installedAt).toLocaleString()}</span>}
        </div>
        {plugin.source && (
          <div className="shrink-0 flex gap-2">
            {confirming ? (
              <>
                <button onClick={() => setConfirming(false)} className="btn btn-sm btn-secondary">Cancel</button>
                <button onClick={() => void uninstall()} disabled={removing} className="btn btn-sm btn-danger-solid">{removing ? 'Removing…' : 'Confirm'}</button>
              </>
            ) : (
              <button onClick={() => setConfirming(true)} className="btn btn-sm btn-danger">Uninstall</button>
            )}
          </div>
        )}
      </div>

      {plugin.loadError && <p className="alert alert-danger text-xs">{plugin.loadError}</p>}
      {error && <p className="alert alert-danger text-xs">{error}</p>}

      {plugin.readme ? (
        <div className="rounded-md p-4" style={{ border: '1px solid var(--border)' }}>
          <Markdown source={plugin.readme} />
        </div>
      ) : (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>This plugin ships no README.</p>
      )}

      <Section title="Strategies" items={strategies.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
      <Section title="Monitors" items={monitors.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
      <Section title="Executors" items={executors.map(d => ({ id: d.id, name: d.name, description: d.description, hint: d.supportedActions?.join(' · ') }))} />
      <Section title="Accounts" items={myAccounts.map(a => ({ id: a.id, name: a.displayName ?? a.id, description: `${a.kind}${a.type ? ` · venue ${a.type}` : ' · any venue'}${a.credentialTypes ? ` · keys: ${a.credentialTypes.join(', ')}` : ''}` }))} />
      <Section title="Credential Types" items={myCredTypes.map(t => ({ id: t.type, name: t.displayName ?? t.type, description: t.description }))} />
      <Section
        title="Adapter Cells"
        items={plugin.cells.map(c => ({ id: `${c.kind}×${c.venue}`, name: `${c.kind} × ${c.venue}` }))}
        chips
      />
      <Section title="Scripts" items={myScripts.map(s => ({ id: s.id, name: s.name, description: s.description }))} />
    </div>
  )
}

function Section({ title, items, chips }: {
  title: string
  items: Array<{ id: string; name: string; description?: string; hint?: string }>
  chips?: boolean
}) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted)' }}>
        {title} <span className="opacity-60">({items.length})</span>
      </div>
      {chips ? (
        <div className="flex flex-wrap gap-1.5">
          {items.map(item => <span key={item.id} className="badge badge-neutral font-mono">{item.name}</span>)}
        </div>
      ) : (
        <div className="flex flex-col rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
          {items.map((item, i) => (
            <div key={item.id} className="px-3 py-2 flex items-baseline gap-3" style={{ borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
              <span className="text-sm shrink-0">{item.name}</span>
              <span className="text-[11px] font-mono shrink-0" style={{ color: 'var(--muted)' }}>{item.id}</span>
              {(item.description || item.hint) && (
                <span className="text-xs truncate ml-auto text-right" style={{ color: 'var(--muted)' }} title={item.description}>
                  {item.description ?? item.hint}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Compiled pseudo-plugin pane (the old Registry page's surviving duty) ─────

function CompiledPane({ compiled, onChanged }: {
  compiled: { strategies: StrategyDefinition[]; monitors: MonitorDefinition[]; executors: ExecutorDefinition[] }
  onChanged: () => void
}) {
  const [importing, setImporting] = useState(false)
  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">AI Compiled</span>
          <span className="badge badge-neutral">compiled components</span>
        </div>
        <button onClick={() => setImporting(v => !v)} className={`btn btn-sm ${importing ? 'btn-secondary' : 'btn-primary'}`}>
          {importing ? 'Cancel' : '+ Import Component'}
        </button>
      </div>
      <p className="text-xs" style={{ color: 'var(--muted)' }}>
        Components registered outside any plugin — the AI compiler's approved output, and manual compiled imports.
      </p>
      {importing && <ImportForm onSuccess={() => { setImporting(false); onChanged() }} />}
      <Section title="Strategies" items={compiled.strategies.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
      <Section title="Monitors" items={compiled.monitors.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
      <Section title="Executors" items={compiled.executors.map(d => ({ id: d.id, name: d.name, description: d.description }))} />
    </div>
  )
}

function ImportForm({ onSuccess }: { onSuccess: () => void }) {
  const [type, setType] = useState<'strategies' | 'monitors' | 'executors'>('strategies')
  const [id, setId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

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
      <input ref={fileRef} type="file" accept=".ts,.js,.mjs" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-sm text-muted" />
      {error && <p className="alert alert-danger text-xs">{error}</p>}
      <button type="submit" disabled={submitting || !file || !id.trim()} className="btn btn-primary btn-sm self-end">
        {submitting ? 'Importing…' : 'Import'}
      </button>
    </form>
  )
}

// ── Install form (unchanged mechanics: npm package or bundle file) ────────────

function InstallForm({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<'npm' | 'file'>('file')
  const [pkg, setPkg] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [config, setConfig] = useState('{}')
  const [error, setError] = useState('')
  const [installing, setInstalling] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    let parsedConfig: unknown
    try {
      parsedConfig = config.trim() === '' ? {} : JSON.parse(config)
    } catch {
      setError('Config must be valid JSON')
      return
    }
    setInstalling(true)
    try {
      let res: Response
      if (mode === 'npm') {
        res = await fetch('/api/plugins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source: 'npm', package: pkg.trim(), config: parsedConfig }),
        })
      } else {
        if (!file) { setError('Choose a .js/.mjs bundle file'); setInstalling(false); return }
        const form = new FormData()
        form.set('file', file)
        form.set('config', JSON.stringify(parsedConfig))
        res = await fetch('/api/plugins', { method: 'POST', body: form })
      }
      if (res.ok) onSuccess()
      else setError(await res.text() || `Install failed (HTTP ${res.status})`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card p-5 flex flex-col gap-4">
      <h2 className="font-semibold text-base">Install Plugin</h2>
      <div className="flex gap-2">
        {(['file', 'npm'] as const).map((m) => (
          <button key={m} type="button" onClick={() => setMode(m)} className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-secondary'}`}>
            {m === 'npm' ? 'From npm' : 'From file'}
          </button>
        ))}
      </div>
      {mode === 'npm' ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">
            Package name or local path <span className="text-danger">*</span>
            <span className="ml-1 opacity-60">— @scope/pkg, name@1.2.0, or an absolute directory like /Users/me/my-plugin (must be built)</span>
          </label>
          <input value={pkg} onChange={(e) => setPkg(e.target.value)} required placeholder="@scope/package-name or /abs/path/to/package" className="input font-mono" />
        </div>
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
      <button type="submit" disabled={installing || (mode === 'npm' ? !pkg.trim() : !file)} className="btn btn-primary self-end">
        {installing ? 'Installing… (npm may take a minute)' : 'Install'}
      </button>
    </form>
  )
}
