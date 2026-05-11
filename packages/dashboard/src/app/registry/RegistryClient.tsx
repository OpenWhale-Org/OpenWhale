'use client'

import { useState, useCallback, useRef } from 'react'
import type { MonitorDefinition, ExecutorDefinition, StrategyDefinition } from '@openwhale/core'

type CompiledType = 'monitors' | 'executors' | 'strategies'

interface RegistryData {
  monitors: MonitorDefinition[]
  executors: ExecutorDefinition[]
  strategies: StrategyDefinition[]
}

interface Props {
  initialData: RegistryData
}

// ── Main component ────────────────────────────────────────────────────────────

export function RegistryClient({ initialData }: Props) {
  const [data, setData] = useState(initialData)
  const [showImport, setShowImport] = useState(false)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/registry')
    if (res.ok) setData(await res.json())
  }, [])

  const total = data.monitors.length + data.executors.length + data.strategies.length

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end gap-2">
        <button
          onClick={refresh}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          Refresh
        </button>
        <button
          onClick={() => setShowImport((v) => !v)}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: showImport ? 'var(--surface)' : 'var(--accent)', color: '#fff', border: showImport ? '1px solid var(--border)' : 'none' }}
        >
          {showImport ? 'Cancel' : '+ Import'}
        </button>
      </div>

      {showImport && (
        <ImportForm
          onSuccess={() => { setShowImport(false); void refresh() }}
          onCancel={() => setShowImport(false)}
        />
      )}

      {total === 0 && !showImport ? (
        <div
          className="rounded-lg p-10 text-center"
          style={{ background: 'var(--surface)', border: '1px dashed var(--border)', color: 'var(--muted)' }}
        >
          <p className="text-sm mb-3">No components registered yet.</p>
          <button
            onClick={() => setShowImport(true)}
            className="px-4 py-2 rounded-md text-sm"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            Import your first component
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          <Section title="Strategies" color="var(--accent)" items={data.strategies} renderItem={(s) => <StrategyRow key={s.id} def={s} />} />
          <Section title="Monitors" color="var(--success)" items={data.monitors} renderItem={(m) => <MonitorRow key={m.id} def={m} />} />
          <Section title="Executors" color="var(--warning)" items={data.executors} renderItem={(e) => <ExecutorRow key={e.id} def={e} />} />
        </div>
      )}
    </div>
  )
}

// ── Import form ───────────────────────────────────────────────────────────────

function ImportForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [type, setType] = useState<CompiledType>('strategies')
  const [id, setId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [idError, setIdError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  function validateId(value: string) {
    if (!/^[a-z0-9-_]+$/i.test(value)) {
      setIdError('Only letters, numbers, hyphens, underscores')
    } else {
      setIdError('')
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file || idError) return
    setError('')
    setSubmitting(true)

    const fd = new FormData()
    fd.append('type', type)
    fd.append('id', id.trim())
    fd.append('file', file)

    const res = await fetch('/api/registry', { method: 'POST', body: fd })
    if (res.ok) {
      onSuccess()
    } else {
      const body = await res.json() as { error?: string }
      setError(body.error ?? 'Import failed')
    }
    setSubmitting(false)
  }

  const typeDescriptions: Record<CompiledType, string> = {
    strategies: 'A class extending BaseStrategy with evaluate() logic',
    monitors: 'A class extending BaseMonitor that collects market data',
    executors: 'A class extending BaseExecutor that executes trade instructions',
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg p-5 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <h2 className="font-semibold text-base">Import Component</h2>

      {/* Type selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
          Component Type <span style={{ color: 'var(--danger)' }}>*</span>
        </label>
        <div className="flex gap-2">
          {(['strategies', 'monitors', 'executors'] as CompiledType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className="px-3 py-1.5 rounded-md text-sm capitalize transition-colors"
              style={{
                background: type === t ? 'var(--accent)' : 'var(--background)',
                color: type === t ? '#fff' : 'var(--muted)',
                border: `1px solid ${type === t ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {typeDescriptions[type]}
        </p>
      </div>

      {/* ID */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
          ID <span style={{ color: 'var(--danger)' }}>*</span>
        </label>
        <input
          value={id}
          onChange={(e) => { setId(e.target.value); validateId(e.target.value) }}
          required
          placeholder="e.g. btc-price-monitor"
          className="rounded-md px-3 py-2 text-sm"
          style={{
            background: 'var(--background)',
            color: 'var(--foreground)',
            border: `1px solid ${idError ? 'var(--danger)' : 'var(--border)'}`,
          }}
        />
        {idError && <span className="text-xs" style={{ color: 'var(--danger)' }}>{idError}</span>}
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          Unique identifier — used as the component's registry key
        </span>
      </div>

      {/* File upload */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
          TypeScript Source File <span style={{ color: 'var(--danger)' }}>*</span>
        </label>
        <div
          className="rounded-md px-4 py-6 text-center cursor-pointer transition-colors"
          style={{
            background: 'var(--background)',
            border: `2px dashed ${file ? 'var(--accent)' : 'var(--border)'}`,
          }}
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const dropped = e.dataTransfer.files[0]
            if (dropped) setFile(dropped)
          }}
        >
          {file ? (
            <div className="flex flex-col items-center gap-1">
              <span className="text-sm font-medium" style={{ color: 'var(--accent)' }}>
                {file.name}
              </span>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                {(file.size / 1024).toFixed(1)} KB — click to change
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1">
              <span className="text-sm" style={{ color: 'var(--muted)' }}>
                Drop a <code>.ts</code> file here, or click to browse
              </span>
              <span className="text-xs" style={{ color: 'var(--muted)', opacity: 0.6 }}>
                The file will be compiled with esbuild and hot-loaded into the runtime
              </span>
            </div>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".ts"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f) }}
        />
      </div>

      {error && (
        <p className="text-sm px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || !file || !id || !!idError}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--accent)', color: '#fff', opacity: submitting || !file || !id ? 0.6 : 1 }}
        >
          {submitting ? 'Compiling…' : 'Compile & Import'}
        </button>
      </div>
    </form>
  )
}

// ── Section ───────────────────────────────────────────────────────────────────

function Section<T>({
  title,
  color,
  items,
  renderItem,
}: {
  title: string
  color: string
  items: T[]
  renderItem: (item: T) => React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full" style={{ background: color }} />
        <h2 className="text-sm font-medium" style={{ color: 'var(--muted)' }}>
          {title}
        </h2>
        <span
          className="text-xs px-1.5 py-0.5 rounded-full"
          style={{ background: color + '22', color }}
        >
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-sm pl-4" style={{ color: 'var(--muted)', opacity: 0.5 }}>
          None registered
        </p>
      ) : (
        <div className="flex flex-col gap-2">{items.map(renderItem)}</div>
      )}
    </div>
  )
}

// ── Row components ────────────────────────────────────────────────────────────

function DefinitionCard({
  id,
  name,
  description,
  source,
  badge,
  children,
}: {
  id: string
  name: string
  description?: string
  source: string
  badge?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div
      className="rounded-lg px-4 py-3 flex items-start justify-between gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{name || id}</span>
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            {source}
          </span>
          {badge}
        </div>
        {description && (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {description}
          </span>
        )}
        <span className="text-xs font-mono" style={{ color: 'var(--muted)', opacity: 0.6 }}>
          {id}
        </span>
        {children}
      </div>
    </div>
  )
}

function StrategyRow({ def }: { def: StrategyDefinition }) {
  return (
    <DefinitionCard id={def.id} name={def.name} description={def.description} source={def.source}>
      <div className="flex flex-wrap gap-2 mt-1">
        {def.monitorIds.length > 0 && (
          <InlineTag label="monitors" values={def.monitorIds} color="var(--success)" />
        )}
        {def.executorIds.length > 0 && (
          <InlineTag label="executors" values={def.executorIds} color="var(--warning)" />
        )}
      </div>
    </DefinitionCard>
  )
}

function MonitorRow({ def }: { def: MonitorDefinition }) {
  return (
    <DefinitionCard id={def.id} name={def.name} description={def.description} source={def.source} />
  )
}

function ExecutorRow({ def }: { def: ExecutorDefinition }) {
  return (
    <DefinitionCard id={def.id} name={def.name} description={def.description} source={def.source}>
      {def.supportedActions.length > 0 && (
        <div className="mt-1">
          <InlineTag label="actions" values={def.supportedActions} color="var(--warning)" />
        </div>
      )}
    </DefinitionCard>
  )
}

function InlineTag({ label, values, color }: { label: string; values: string[]; color: string }) {
  return (
    <span className="text-xs flex items-center gap-1 flex-wrap" style={{ color: 'var(--muted)' }}>
      {label}:
      {values.map((v) => (
        <span key={v} className="px-1.5 py-0.5 rounded" style={{ background: color + '22', color }}>
          {v}
        </span>
      ))}
    </span>
  )
}
