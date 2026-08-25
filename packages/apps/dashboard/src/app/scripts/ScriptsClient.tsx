'use client'

import { useEffect, useMemo, useState } from 'react'
import { Rail, RailGroup, RailItem } from '../../components/Rail'
import type { ScriptInfo, ParamFieldDef } from '@openwhaleorg/core'
import { TypeMark } from '../../components/TypeMark'

/**
 * Scripts — plugin-shipped operator utilities, run on click. A rail on the
 * left lists every script grouped by the package that ships it; the pane on
 * the right is the selected script's form (derived from its zod schema), its
 * Run button and the report it returns. No lifecycle, no persistence —
 * anything recurring belongs in a monitor or strategy.
 *
 * The earlier folder shelf (drag to re-file, unmount to hide) went away with
 * this layout: the package IS the grouping, and a rail scales to any number
 * of scripts without hiding any.
 */

const SELECTED_KEY = 'ow.scripts.selected'

function readSelection(): Set<string> {
  try {
    const raw = localStorage.getItem(SELECTED_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function ScriptsClient() {
  const [scripts, setScripts] = useState<ScriptInfo[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** Multi-select: several scripts open side by side in the pane, remembered per browser. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(readSelection)

  useEffect(() => {
    void fetch('/api/scripts')
      .then(async r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); setScripts(await r.json() as ScriptInfo[]) })
      .catch(err => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const hits = (scripts ?? []).filter(s => !q || s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
    const byPkg = new Map<string, ScriptInfo[]>()
    for (const s of hits) {
      const list = byPkg.get(s.pluginName) ?? []
      list.push(s)
      byPkg.set(s.pluginName, list)
    }
    return Array.from(byPkg.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([pkg, items]) => ({ pkg, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
  }, [scripts, query])

  // Open scripts in rail order; with nothing remembered, land on the first one
  const known = new Set((scripts ?? []).map(s => s.id))
  const openIds = Array.from(selectedIds).filter(id => known.has(id))
  const open = openIds.length > 0
    ? (scripts ?? []).filter(s => selectedIds.has(s.id))
    : groups[0]?.items[0] ? [groups[0].items[0]] : []
  function toggle(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      try { localStorage.setItem(SELECTED_KEY, JSON.stringify(Array.from(next))) } catch { /* private mode */ }
      return next
    })
  }
  function clearSelection() {
    setSelectedIds(new Set())
    try { localStorage.removeItem(SELECTED_KEY) } catch { /* private mode */ }
  }

  const header = (
    <div className="mb-4">
      <h1 className="text-2xl font-semibold">Scripts</h1>
      <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>Plugin-shipped operator utilities, run on demand</p>
    </div>
  )

  if (error) return <div>{header}<div className="text-sm" style={{ color: 'var(--danger)' }}>Failed to load: {error}</div></div>
  if (scripts === null) return <div>{header}<div className="text-sm" style={{ color: 'var(--muted)' }}>Loading…</div></div>
  if (scripts.length === 0) {
    return <div>{header}<div className="text-sm" style={{ color: 'var(--muted)' }}>No scripts registered — plugins provide them via `scripts: [...]`.</div></div>
  }

  return (
    <div>
      {header}
      <div className="flex gap-3" style={{ height: 'calc(100vh - 13rem)', minHeight: 460 }}>
        {/* ── rail: scripts by package ─────────────────────────────────── */}
        <Rail
          width="18rem"
          search={{ value: query, onChange: setQuery, placeholder: 'Search scripts…' }}
          footer={
            <div className="px-3 py-2 text-[11px] flex items-center gap-2" style={{ color: 'var(--muted)' }}>
              <span>{scripts.length} scripts · {groups.length} packages · {open.length} open</span>
              {openIds.length > 0 && (
                <button onClick={clearSelection} className="ml-auto px-2 py-0.5 rounded-md" style={{ border: '1px solid var(--border)' }}>Clear</button>
              )}
            </div>
          }
        >
          {groups.length === 0 && <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>Nothing matches.</p>}
          {groups.map(({ pkg, items }) => (
            <RailGroup
              key={pkg}
              label={pkg}
              count={items.length}
              mark={<TypeMark label={pkg} size={16} />}
              collapsed={collapsed.has(pkg) && !query}
              onToggle={() => setCollapsed(prev => { const next = new Set(prev); if (!next.delete(pkg)) next.add(pkg); return next })}
            >
              {items.map(s => {
                const active = open.some(o => o.id === s.id)
                return (
                  <RailItem
                    key={s.id}
                    checkbox
                    active={active}
                    onClick={() => toggle(s.id)}
                    title_={active ? 'Click to close' : 'Click to open alongside'}
                    title={s.name}
                    subtitle={s.description}
                  />
                )
              })}
            </RailGroup>
          ))}
        </Rail>

        {/* ── detail: the selected script ──────────────────────────────── */}
        <div className="flex-1 min-w-0 min-h-0 overflow-y-auto scroll-hidden flex flex-col gap-3">
          {open.length > 0 ? open.map(s => (
            <ScriptCard key={s.id} script={s} />
          )) : (
            <div className="rounded-lg p-10 text-center text-sm" style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}>
              Pick one or more scripts.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface ScriptFile { name: string; mime?: string; content: string }
interface ScriptOutput { text: string; json?: unknown; files?: ScriptFile[] }

const sizeLabel = (s: string): string => {
  const kb = new Blob([s]).size / 1024
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`
}

/**
 * Open the attachment in its own tab.
 *
 * A blob: URL inherits this origin, so the page opens with the dashboard's
 * privileges — acceptable only because these reports are generated by trusted
 * plugin code server-side and carry no scripts. The inline preview below is
 * stricter (sandboxed iframe, scripting off) because that one renders inside
 * the dashboard's own document.
 */
function openFile(file: ScriptFile): void {
  const blob = new Blob([file.content], { type: file.mime ?? 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  window.open(url, '_blank', 'noopener')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/**
 * Hand the file to the browser from memory — the script never wrote it to the
 * server, so there is no URL to link and nothing left behind after the save.
 */
function downloadFile(file: ScriptFile): void {
  const blob = new Blob([file.content], { type: file.mime ?? 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking in the same tick cancels the save in Safari — the download reads
  // the blob asynchronously after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
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
    // A multi-select starts empty on purpose — seeding it with the first
    // option would silently pick one item out of a list the user came here
    // to choose from, and "none selected" is a meaningful state for it.
    if (f.multiple) continue
    if (f.default !== undefined) out[f.name] = String(f.default)
    else if (f.type === 'options' && f.options?.[0] !== undefined) out[f.name] = String(f.options[0].value)
    else if (f.type === 'boolean') out[f.name] = 'false'
  }
  return out
}

function ScriptCard({ script }: { script: ScriptInfo }) {
  const [values, setValues] = useState<Record<string, string>>(() => seedValues(script.paramsFields))
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ScriptOutput | null>(null)
  const [runError, setRunError] = useState('')
  const [view, setView] = useState<'report' | 'html' | 'json'>('report')
  const [ranAt, setRanAt] = useState<Date | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)

  const fields = script.paramsFields ?? []
  const htmlFile = result?.files?.find(f => (f.mime ?? '').includes('html') || f.name.endsWith('.html'))

  // A rerun can take away the view you were on (HTML off, or a script that
  // returns no attachment). Falling back beats rendering an empty panel.
  useEffect(() => {
    if (view === 'html' && !htmlFile) setView('report')
    if (view === 'json' && result?.json === undefined) setView('report')
  }, [view, htmlFile, result])

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
        let done: ScriptOutput | undefined
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
            let frame: { type?: string; text?: string; json?: unknown; files?: ScriptFile[]; error?: string }
            try { frame = JSON.parse(part) } catch { continue }
            if (frame.type === 'line') { lines.push(frame.text ?? ''); setResult({ text: lines.join('\n') }) }
            else if (frame.type === 'result') done = { text: frame.text ?? '', ...(frame.json !== undefined ? { json: frame.json } : {}), ...(frame.files?.length ? { files: frame.files } : {}) }
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
        const body = await legacy.json() as { text?: string; json?: unknown; files?: ScriptFile[]; error?: string }
        if (!legacy.ok) throw new Error(body.error ?? `HTTP ${legacy.status}`)
        setResult({ text: body.text ?? '', ...(body.json !== undefined ? { json: body.json } : {}), ...(body.files?.length ? { files: body.files } : {}) })
        setRanAt(new Date())
      }
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="hoverable rounded-lg p-4" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      {/* Identity left, the one action right. */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium">{script.name}</div>
          <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
            {script.id}
            {script.description && <> — {script.description}</>}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-1">
          <button
            onClick={() => void run()}
            disabled={running}
            className="px-4 py-1.5 rounded-md text-sm mr-1"
            style={{ background: running ? 'var(--border)' : 'var(--accent)', color: '#fff' }}
          >
            {running ? 'Running…' : '▶ Run'}
          </button>
        </div>
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
            <div className="flex rounded overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              {(['report', ...(htmlFile ? ['html'] as const : []), ...(result.json !== undefined ? ['json'] as const : [])] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className="text-xs px-2 py-0.5"
                  style={{
                    background: view === v ? 'var(--accent)' : 'transparent',
                    color: view === v ? '#fff' : 'var(--muted)',
                  }}
                >
                  {v === 'report' ? 'Report' : v === 'html' ? 'HTML' : 'JSON'}
                </button>
              ))}
            </div>
            {result.files?.map(f => (
              <span key={f.name} className="flex items-center gap-1">
                <button
                  onClick={() => openFile(f)}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ border: '1px solid var(--accent)', color: 'var(--accent)' }}
                  title={`${f.name} · ${f.mime ?? 'text/plain'} · ${sizeLabel(f.content)}`}
                >
                  ↗ Open
                </button>
                <button
                  onClick={() => downloadFile(f)}
                  className="text-xs px-2 py-0.5 rounded"
                  style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                  title={`Save ${f.name} (${sizeLabel(f.content)})`}
                >
                  ⤓
                </button>
              </span>
            ))}
            <button
              onClick={async () => {
                // Copy what is on screen, not always the report: whichever view
                // is up is what the reader means by "this".
                const shown = view === 'json' && result.json !== undefined
                  ? JSON.stringify(result.json, null, 2)
                  : view === 'html' && htmlFile
                    ? htmlFile.content
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
          {view === 'html' && htmlFile ? (
            /*
             * `allow-scripts` WITHOUT `allow-same-origin`: the report's own
             * interactivity (hiding a series, jumping to a section) runs, but
             * the document sits in an opaque origin — it cannot reach this
             * page's DOM, cookies, or storage, and cannot navigate the top
             * frame. That pairing is what makes running the script safe; adding
             * `allow-same-origin` alongside it would hand the report this
             * origin and undo the sandbox entirely.
             */
            <iframe
              title={htmlFile.name}
              srcDoc={htmlFile.content}
              sandbox="allow-scripts"
              className="w-full rounded-md"
              style={{
                background: 'var(--background)', border: '1px solid var(--border)',
                ...(expanded ? { height: '80vh' } : { height: 480, minHeight: 160, resize: 'vertical' as const }),
              }}
            />
          ) : (
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
              {view === 'json' && result.json !== undefined ? JSON.stringify(result.json, null, 2) : result.text}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Checkbox list for a field declaring `multiple` — stored comma-separated, the
 * same wire format Instances already uses, so a script reads one string and
 * splits it.
 *
 * A native <select multiple> was the obvious choice and the wrong one: it
 * shows three rows, needs ctrl-click to add without clearing the rest, and
 * gives no count. Picking several settlements is the whole point of the
 * field, so the control has to make picking several the easy path.
 */
function MultiSelect({ options, value, onChange }: {
  options: NonNullable<ParamFieldDef['options']>
  value: string
  onChange: (v: string) => void
}) {
  const chosen = value ? value.split(',').filter(Boolean) : []
  const toggle = (v: string) => {
    const next = chosen.includes(v) ? chosen.filter(x => x !== v) : [...chosen, v]
    onChange(next.join(','))
  }
  return (
    <div className="rounded-md" style={{ background: 'var(--background)', border: '1px solid var(--border)', minWidth: '22rem' }}>
      <div className="flex items-center justify-between px-2 py-1" style={{ borderBottom: '1px solid var(--border)' }}>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {chosen.length === 0 ? 'none selected — script picks its default' : `${chosen.length} selected`}
        </span>
        {chosen.length > 0 && (
          <button type="button" onClick={() => onChange('')} className="text-xs px-1.5 py-0.5 rounded" style={{ color: 'var(--muted)' }}>
            Clear
          </button>
        )}
      </div>
      <div className="flex flex-col overflow-y-auto" style={{ maxHeight: '11rem' }}>
        {options.map(o => {
          const v = String(o.value)
          const on = chosen.includes(v)
          return (
            <button
              key={v}
              type="button"
              onClick={() => toggle(v)}
              className="flex items-start gap-2 text-left text-xs px-2 py-1 font-mono"
              style={{ background: on ? 'var(--surface)' : 'transparent', color: 'var(--foreground)' }}
            >
              <span style={{ color: on ? 'var(--accent)' : 'var(--muted)' }}>{on ? '☑' : '☐'}</span>
              <span className="min-w-0">{o.label}</span>
            </button>
          )
        })}
      </div>
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
      {field.multiple && field.options ? (
        <MultiSelect options={field.options} value={value} onChange={onChange} />
      ) : field.type === 'options' && field.options ? (
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
