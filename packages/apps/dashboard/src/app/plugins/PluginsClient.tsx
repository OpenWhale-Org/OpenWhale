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
          className={`btn ${showForm ? 'btn-secondary' : 'btn-primary'}`}
        >
          {showForm ? 'Cancel' : '+ Install Plugin'}
        </button>
      </div>

      {showForm && (
        <InstallForm onSuccess={() => { setShowForm(false); void refresh() }} />
      )}

      {plugins.length === 0 && !showForm ? (
        <div
          className="alert alert-muted border-dashed p-8 text-center"
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
      className="card p-5 mb-4 flex flex-col gap-4"
    >
      <h2 className="font-semibold text-base">Install Plugin</h2>

      {/* Source selector */}
      <div className="flex gap-2">
        {(['npm', 'file'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-secondary'}`}
          >
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
          <input
            value={pkg}
            onChange={(e) => setPkg(e.target.value)}
            required
            placeholder="@scope/package-name or /abs/path/to/package"
            className="input font-mono"
          />
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted">
            Plugin bundle <span className="text-danger">*</span>
            <span className="ml-1 opacity-60">— built ESM .js/.mjs, default-exporting a plugin factory</span>
          </label>
          <input
            type="file"
            accept=".js,.mjs"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm text-muted"
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted">
          Config (JSON) — passed to the plugin factory
        </label>
        <textarea
          value={config}
          onChange={(e) => setConfig(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder='{ "testnet": true }'
          className="input font-mono resize-y"
        />
      </div>

      <p className="alert alert-warning text-xs">
        ⚠️ Installing a plugin runs third-party code inside the engine process with full access to
        credentials and accounts. Only install packages you trust.
      </p>

      {error && (
        <p className="alert alert-danger whitespace-pre-wrap">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={installing || (mode === 'npm' ? !pkg.trim() : !file)}
        className="btn btn-primary self-end"
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
      className="card p-4 flex flex-col gap-2"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{plugin.name}</span>
            <span className="badge badge-neutral">
              v{plugin.version}
            </span>
            <span className="badge badge-neutral">
              {builtIn ? 'built-in'
                : plugin.source!.kind === 'npm' ? `npm: ${plugin.source!.package}`
                : plugin.source!.kind === 'local' ? `local: ${plugin.source!.path}`
                : `file: ${plugin.source!.originalName}`}
            </span>
            {plugin.loadError && (
              <span className="badge badge-danger">
                load failed
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-3 text-xs text-muted">
            <span>{plugin.monitors.length} monitors</span>
            <span>{plugin.executors.length} executors</span>
            <span>{plugin.strategies.length} strategies</span>
            <span>{plugin.kinds.length} kinds</span>
            <span>{plugin.credentialTypes.length} credential types</span>
            {plugin.installedAt && <span>installed {new Date(plugin.installedAt).toLocaleString()}</span>}
          </div>
          {plugin.strategies.length > 0 && (
            <span className="text-xs font-mono text-muted opacity-70">
              {plugin.strategies.join(' · ')}
            </span>
          )}
          {plugin.loadError && (
            <span className="text-xs text-danger">{plugin.loadError}</span>
          )}
        </div>

        {!builtIn && (
          <div className="shrink-0 flex gap-2">
            {confirming ? (
              <>
                <button
                  onClick={() => setConfirming(false)}
                  className="btn btn-sm btn-secondary"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void uninstall()}
                  disabled={removing}
                  className="btn btn-sm btn-danger-solid"
                >
                  {removing ? 'Removing…' : 'Confirm'}
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="btn btn-sm btn-danger"
              >
                Uninstall
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="alert alert-danger text-xs">
          {error}
        </p>
      )}
    </div>
  )
}
