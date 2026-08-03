'use client'

import { useState } from 'react'
import type { InstalledPluginView } from '@/lib/data'

interface Props {
  initialPlugins: InstalledPluginView[]
}

export function PluginsClient({ initialPlugins }: Props) {
  const [plugins, setPlugins] = useState(initialPlugins)
  const [showForm, setShowForm] = useState(false)

  async function refresh() {
    const res = await fetch('/api/plugins')
    if (res.ok) setPlugins(await res.json() as InstalledPluginView[])
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 rounded-md text-sm transition-colors"
          style={{
            background: showForm ? 'var(--surface)' : 'var(--accent)',
            color: '#fff',
            border: showForm ? '1px solid var(--border)' : 'none',
          }}
        >
          {showForm ? 'Cancel' : '+ Install Plugin'}
        </button>
      </div>

      {showForm && (
        <InstallForm onSuccess={() => { setShowForm(false); void refresh() }} />
      )}

      {plugins.length === 0 && !showForm ? (
        <div
          className="rounded-lg p-8 text-center text-sm"
          style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px dashed var(--border)' }}
        >
          No plugins installed. Built-in plugins loaded from code (e.g. hyperliquid) appear here too.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {plugins.map((p) => (
            <PluginCard key={p.name} plugin={p} onChanged={() => void refresh()} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Install form ──────────────────────────────────────────────────────────────

function InstallForm({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<'npm' | 'file'>('npm')
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
      if (res.ok) {
        onSuccess()
      } else {
        setError(await res.text() || `Install failed (HTTP ${res.status})`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg p-5 mb-4 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <h2 className="font-semibold text-base">Install Plugin</h2>

      {/* Source selector */}
      <div className="flex gap-2">
        {(['npm', 'file'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className="px-3 py-1.5 rounded-md text-sm transition-colors"
            style={{
              background: mode === m ? 'var(--accent)' : 'var(--background)',
              color: mode === m ? '#fff' : 'var(--muted)',
              border: `1px solid ${mode === m ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            {m === 'npm' ? 'From npm' : 'From file'}
          </button>
        ))}
      </div>

      {mode === 'npm' ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: 'var(--muted)' }}>
            Package name or local path <span style={{ color: 'var(--danger)' }}>*</span>
            <span className="ml-1" style={{ opacity: 0.6 }}>— @scope/pkg, name@1.2.0, or an absolute directory like /Users/me/my-plugin (must be built)</span>
          </label>
          <input
            value={pkg}
            onChange={(e) => setPkg(e.target.value)}
            required
            placeholder="@scope/package-name or /abs/path/to/package"
            className="rounded-md px-3 py-2 text-sm font-mono"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: 'var(--muted)' }}>
            Plugin bundle <span style={{ color: 'var(--danger)' }}>*</span>
            <span className="ml-1" style={{ opacity: 0.6 }}>— built ESM .js/.mjs, default-exporting a plugin factory</span>
          </label>
          <input
            type="file"
            accept=".js,.mjs"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm"
            style={{ color: 'var(--muted)' }}
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="text-xs" style={{ color: 'var(--muted)' }}>
          Config (JSON) — passed to the plugin factory
        </label>
        <textarea
          value={config}
          onChange={(e) => setConfig(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder='{ "testnet": true }'
          className="rounded-md px-3 py-2 text-sm font-mono resize-y"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        />
      </div>

      <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3a2e1a', color: 'var(--warning)' }}>
        ⚠️ Installing a plugin runs third-party code inside the engine process with full access to
        credentials and accounts. Only install packages you trust.
      </p>

      {error && (
        <p className="text-sm px-3 py-2 rounded-md whitespace-pre-wrap" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={installing || (mode === 'npm' ? !pkg.trim() : !file)}
        className="self-end px-4 py-2 rounded-md text-sm"
        style={{ background: 'var(--accent)', color: '#fff', opacity: installing ? 0.6 : 1 }}
      >
        {installing ? 'Installing… (npm may take a minute)' : 'Install'}
      </button>
    </form>
  )
}

// ── Plugin card ───────────────────────────────────────────────────────────────

function PluginCard({ plugin, onChanged }: { plugin: InstalledPluginView; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState(false)

  const builtIn = !plugin.source

  async function uninstall() {
    setRemoving(true)
    setError('')
    const res = await fetch(`/api/plugins/${encodeURIComponent(plugin.name)}`, { method: 'DELETE' })
    setRemoving(false)
    if (res.ok) {
      onChanged()
    } else {
      setConfirming(false)
      setError(await res.text() || `Uninstall failed (HTTP ${res.status})`)
    }
  }

  return (
    <div
      className="rounded-lg p-4 flex flex-col gap-2"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{plugin.name}</span>
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
              v{plugin.version}
            </span>
            <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
              {builtIn ? 'built-in'
                : plugin.source!.kind === 'npm' ? `npm: ${plugin.source!.package}`
                : plugin.source!.kind === 'local' ? `local: ${plugin.source!.path}`
                : `file: ${plugin.source!.originalName}`}
            </span>
            {plugin.loadError && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
                load failed
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-3 text-xs" style={{ color: 'var(--muted)' }}>
            <span>{plugin.monitors.length} monitors</span>
            <span>{plugin.executors.length} executors</span>
            <span>{plugin.strategies.length} strategies</span>
            <span>{plugin.kinds.length} kinds</span>
            <span>{plugin.credentialTypes.length} credential types</span>
            {plugin.installedAt && <span>installed {new Date(plugin.installedAt).toLocaleString()}</span>}
          </div>
          {plugin.strategies.length > 0 && (
            <span className="text-xs font-mono" style={{ color: 'var(--muted)', opacity: 0.7 }}>
              {plugin.strategies.join(' · ')}
            </span>
          )}
          {plugin.loadError && (
            <span className="text-xs" style={{ color: 'var(--danger)' }}>{plugin.loadError}</span>
          )}
        </div>

        {!builtIn && (
          <div className="shrink-0 flex gap-2">
            {confirming ? (
              <>
                <button
                  onClick={() => setConfirming(false)}
                  className="px-3 py-1.5 rounded-md text-xs"
                  style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => void uninstall()}
                  disabled={removing}
                  className="px-3 py-1.5 rounded-md text-xs"
                  style={{ background: 'var(--danger)', color: '#fff', opacity: removing ? 0.6 : 1 }}
                >
                  {removing ? 'Removing…' : 'Confirm'}
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="px-3 py-1.5 rounded-md text-xs"
                style={{ background: '#3f1f1f', color: 'var(--danger)', border: '1px solid #7f1d1d' }}
              >
                Uninstall
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  )
}
