'use client'

import { useEffect, useState } from 'react'
import type { ScriptInfo, ParamFieldDef } from '@openwhaleorg/core'

/**
 * Scripts — plugin-shipped operator utilities, run on click. One card per
 * script: a small flat param form (derived from the script's zod schema) and
 * the monospace report it returns. No lifecycle, no persistence — anything
 * recurring belongs in a monitor or strategy.
 */
export function ScriptsClient() {
  const [scripts, setScripts] = useState<ScriptInfo[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void fetch('/api/scripts')
      .then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); setScripts(await r.json() as ScriptInfo[]) })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  if (error) return <div className="text-sm" style={{ color: 'var(--danger)' }}>Failed to load: {error}</div>
  if (scripts === null) return <div className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>
  if (scripts.length === 0) {
    return <div className="text-sm" style={{ color: 'var(--muted)' }}>No scripts registered — plugins provide them via `scripts: [...]`.</div>
  }

  return (
    <div className="flex flex-col gap-4">
      {scripts.map(s => <ScriptCard key={s.id} script={s} />)}
    </div>
  )
}

function ScriptCard({ script }: { script: ScriptInfo }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ text: string; json?: unknown } | null>(null)
  const [runError, setRunError] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [ranAt, setRanAt] = useState<Date | null>(null)
  const [expanded, setExpanded] = useState(false)

  const fields = script.paramsFields ?? []

  async function run() {
    setRunning(true)
    setRunError('')
    try {
      const params: Record<string, unknown> = {}
      for (const f of fields) {
        const raw = values[f.name]
        if (raw === undefined || raw === '') continue
        params[f.name] = f.type === 'number' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw
      }
      const [owner, ...rest] = script.id.split('/')
      const res = await fetch(`/api/scripts/${encodeURIComponent(owner!)}/${encodeURIComponent(rest.join('/'))}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params }),
      })
      const body = await res.json() as { text?: string; json?: unknown; error?: string }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setResult({ text: body.text ?? '', ...(body.json !== undefined ? { json: body.json } : {}) })
      setRanAt(new Date())
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="rounded-lg p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium">{script.name}</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            {script.id}
            {script.description && <> — {script.description}</>}
          </div>
        </div>
        <button
          onClick={() => void run()}
          disabled={running}
          className="shrink-0 px-4 py-1.5 rounded-md text-sm"
          style={{ background: running ? 'var(--border)' : 'var(--accent)', color: '#fff' }}
        >
          {running ? 'Running…' : '▶ Run'}
        </button>
      </div>

      {fields.length > 0 && (
        <div className="flex flex-wrap gap-3 mt-3">
          {fields.map(f => <FieldInput key={f.name} field={f} value={values[f.name] ?? ''} onChange={v => setValues(prev => ({ ...prev, [f.name]: v }))} />)}
        </div>
      )}

      {runError && <div className="text-xs mt-3" style={{ color: 'var(--danger)' }}>{runError}</div>}

      {result && (
        <div className="mt-3">
          <div className="flex items-center gap-3 mb-1">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              Output{ranAt ? ` · ${ranAt.toLocaleTimeString()}` : ''}
            </span>
            {result.json !== undefined && (
              <button onClick={() => setShowJson(v => !v)} className="text-xs px-2 py-0.5 rounded" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
                {showJson ? 'Report' : 'JSON'}
              </button>
            )}
            <button onClick={() => setExpanded(v => !v)} className="text-xs px-2 py-0.5 rounded" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
              {expanded ? '⤡ Collapse' : '⤢ Expand all'}
            </button>
            {!expanded && <span className="text-xs" style={{ color: 'var(--muted)' }}>(drag the corner to resize)</span>}
          </div>
          <pre
            className="text-xs p-3 rounded-md whitespace-pre-wrap"
            style={{
              background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)',
              overflow: 'auto',
              // Free-form: expanded shows everything; collapsed starts at 480px
              // with a native drag handle (resize needs a height, not a max).
              ...(expanded ? {} : { height: 480, minHeight: 160, resize: 'vertical' as const }),
            }}
          >
            {showJson && result.json !== undefined ? JSON.stringify(result.json, null, 2) : result.text}
          </pre>
        </div>
      )}
    </div>
  )
}

function FieldInput({ field, value, onChange }: { field: ParamFieldDef; value: string; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-col gap-1 text-xs" style={{ color: 'var(--muted)' }}>
      <span>
        {field.displayName ?? field.name}
        {field.description && <span title={field.description}> ⓘ</span>}
      </span>
      {field.type === 'options' && field.options ? (
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className="rounded-md px-2 py-1.5 text-sm font-mono"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', minWidth: '16rem' }}
        >
          {field.options.map(o => (
            <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
          ))}
        </select>
      ) : field.type === 'boolean' ? (
        <select
          value={value || 'false'}
          onChange={e => onChange(e.target.value)}
          className="rounded-md px-2 py-1.5 text-sm"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          <option value="false">false</option>
          <option value="true">true</option>
        </select>
      ) : (
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder ?? (field.default !== undefined ? String(field.default) : undefined)}
          className="rounded-md px-2 py-1.5 text-sm font-mono"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', minWidth: '16rem' }}
        />
      )}
    </label>
  )
}
