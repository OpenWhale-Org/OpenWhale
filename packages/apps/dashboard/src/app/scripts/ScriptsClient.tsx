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

/**
 * Seed the form from what the field ALREADY shows.
 *
 * A `<select>` with no value renders its first option, so the form looked
 * filled in while the state behind it was empty and the run submitted
 * `undefined` — the field displayed one thing and sent another. Defaults do
 * the same for text fields: a script author who set `.default()` expects that
 * value to be sent without the user retyping it.
 */
function seedValues(fields: ScriptInfo['paramsFields']): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields ?? []) {
    if (f.default !== undefined) out[f.name] = String(f.default)
    else if (f.type === 'options' && f.options?.[0] !== undefined) out[f.name] = String(f.options[0].value)
    else if (f.type === 'boolean') out[f.name] = 'false'
  }
  return out
}

function ScriptCard({ script }: { script: ScriptInfo }) {
  const [values, setValues] = useState<Record<string, string>>(() => seedValues(script.paramsFields))
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ text: string; json?: unknown } | null>(null)
  const [runError, setRunError] = useState('')
  const [showJson, setShowJson] = useState(false)
  const [ranAt, setRanAt] = useState<Date | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const fields = script.paramsFields ?? []

  // paramOptions resolves server-side on every listing, so the option list can
  // arrive after the first render. Re-seed the fields that are still empty —
  // never overwrite something the user has already touched.
  useEffect(() => {
    setValues(prev => {
      const seeded = seedValues(script.paramsFields)
      const next = { ...prev }
      let changed = false
      for (const [k, v] of Object.entries(seeded)) {
        if (next[k] === undefined || next[k] === '') { next[k] = v; changed = true }
      }
      return changed ? next : prev
    })
  }, [script.paramsFields])

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
      const base = `/api/scripts/${encodeURIComponent(owner!)}/${encodeURIComponent(rest.join('/'))}`
      const post = (path: string) => fetch(base + path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ params }),
      })

      // Stream by default. /api is proxied through Next, which severs an idle
      // connection at 30s, so a script that only spoke at the end returned a
      // bare "Internal Server Error" however well it had run. Streaming keeps
      // bytes moving and shows the run as it happens.
      const res = await post('/stream')
      if (res.ok && res.body) {
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        const lines: string[] = []
        let done: { text: string; json?: unknown } | undefined
        let failed: string | undefined
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          // Frames are newline-delimited; a chunk can split one in half, so the
          // trailing partial stays in the buffer until its newline arrives.
          const parts = buffer.split('\n')
          buffer = parts.pop() ?? ''
          for (const part of parts) {
            if (!part.trim()) continue
            let frame: { type?: string; text?: string; json?: unknown; error?: string }
            try { frame = JSON.parse(part) } catch { continue }
            if (frame.type === 'line') { lines.push(frame.text ?? ''); setResult({ text: lines.join('\n') }) }
            else if (frame.type === 'result') done = { text: frame.text ?? '', ...(frame.json !== undefined ? { json: frame.json } : {}) }
            else if (frame.type === 'error') failed = frame.error ?? 'script failed'
          }
        }
        if (failed !== undefined) throw new Error(failed)
        // No terminal frame means the connection died mid-run. Keep whatever
        // was streamed — it is the only record of what actually happened.
        if (done === undefined) throw new Error('connection closed before the script finished')
        setResult(done)
        setRanAt(new Date())
      } else {
        // Older gateway without the streaming route.
        const legacy = await post('/run')
        const body = await legacy.json() as { text?: string; json?: unknown; error?: string }
        if (!legacy.ok) throw new Error(body.error ?? `HTTP ${legacy.status}`)
        setResult({ text: body.text ?? '', ...(body.json !== undefined ? { json: body.json } : {}) })
        setRanAt(new Date())
      }
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
            <button
              onClick={async () => {
                // Copy what is on screen, not always the report: with the JSON
                // toggle on, the JSON is what the reader means by "this".
                const shown = showJson && result.json !== undefined
                  ? JSON.stringify(result.json, null, 2)
                  : result.text
                try {
                  await navigator.clipboard.writeText(shown)
                } catch {
                  // Clipboard needs a secure context; fall back so the button
                  // is never a dead end on plain http.
                  const ta = document.createElement('textarea')
                  ta.value = shown
                  ta.style.position = 'fixed'
                  ta.style.opacity = '0'
                  document.body.appendChild(ta)
                  ta.select()
                  document.execCommand('copy')
                  document.body.removeChild(ta)
                }
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
              className="text-xs px-2 py-0.5 rounded"
              style={{ border: '1px solid var(--border)', color: copied ? 'var(--foreground)' : 'var(--muted)' }}
            >
              {copied ? '✓ Copied' : '⧉ Copy'}
            </button>
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
