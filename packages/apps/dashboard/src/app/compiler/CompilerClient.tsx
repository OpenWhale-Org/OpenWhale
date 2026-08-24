'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { CompileJob, DraftFile } from '@openwhaleorg/compiler'
import { subscribeLiveEvents } from '@/lib/live-events'
import { CodeEditor } from '@/components/CodeEditor'

/**
 * The compiler as a workbench: sessions on the left (LLM settings tucked
 * beneath them), and on the right a compile zone, the code zone (Monaco with
 * the framework's real type surface), the agent conversation, and one
 * context-aware input box at the bottom — confirm, iterate, or approve,
 * depending on where the job stands.
 */

const ACTIVE_STATUSES = new Set(['analyzing', 'generating', 'validating'])

const STATUS_LABEL: Record<string, string> = {
  analyzing: 'Analyzing…',
  awaiting_confirmation: 'Awaiting confirmation',
  generating: 'Generating…',
  validating: 'Validating…',
  draft: 'Draft ready',
  failed: 'Failed',
  approved: 'Registered',
}

const STATUS_COLOR: Record<string, string> = {
  draft: 'var(--warning)',
  failed: 'var(--danger)',
  approved: 'var(--success)',
}

/** Compiled output is categorized by kind — the tabs over the editor, one hue each. */
const KIND_ORDER = ['strategies', 'monitors', 'executors'] as const
const KIND_LABEL: Record<string, string> = { strategies: 'Strategy', monitors: 'Monitor', executors: 'Executor' }
const KIND_COLOR: Record<string, string> = { strategies: 'var(--accent)', monitors: 'var(--success)', executors: 'var(--warning)' }

export function CompilerClient({ initialJobs }: { initialJobs: CompileJob[] }) {
  const [jobs, setJobs] = useState(initialJobs)
  const [selectedId, setSelectedId] = useState<string | null>(initialJobs[0]?.id ?? null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/compiler/jobs')
    if (res.ok) setJobs(await res.json() as CompileJob[])
  }, [])

  useEffect(() => subscribeLiveEvents((event) => {
    if ((event as { type?: string }).type === 'compiler') void refresh()
  }), [refresh])

  async function createJob(description: string) {
    setCreating(true)
    setError('')
    try {
      const res = await fetch('/api/compiler/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, target: 'auto' }),
      })
      if (!res.ok) { setError(await res.text()); return }
      const job = await res.json() as CompileJob
      setSelectedId(job.id)
      await refresh()
    } finally {
      setCreating(false)
    }
  }

  const selected = jobs.find(j => j.id === selectedId) ?? null
  const [llm, setLlm] = useLlmSettings()
  const configured = llmConfigured(llm)

  async function act(body: Record<string, unknown>) {
    if (!selected) return
    setBusy(true)
    setError('')
    const res = await fetch(`/api/compiler/jobs/${selected.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    if (!res.ok) setError(await res.text())
    else void refresh()
  }

  return (
    <div className="flex-1 min-h-0 flex gap-3">
      {/* ── sessions rail ─────────────────────────────────────────────────── */}
      <div
        className="flex flex-col rounded-lg overflow-hidden shrink-0"
        style={{ width: '17rem', background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div className="px-3 py-2 text-xs font-semibold shrink-0 flex items-center justify-between" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
          <span>SESSIONS</span>
          <button
            onClick={() => { setSelectedId(null); setError('') }}
            className="px-2 py-0.5 rounded-md text-xs"
            style={{
              color: selectedId === null ? 'var(--foreground)' : 'var(--muted)',
              border: `1px solid ${selectedId === null ? 'var(--accent)' : 'var(--border)'}`,
              background: selectedId === null ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
            }}
          >
            + New
          </button>
        </div>
        {llm && !configured ? (
          <SettingsPanel state={llm} onChange={setLlm} centered />
        ) : (
        <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
          {jobs.length === 0 && (
            <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>
              No compile sessions yet — describe a strategy below.
            </p>
          )}
          {jobs.map(job => (
            <button
              key={job.id}
              onClick={() => { setSelectedId(job.id); setError('') }}
              className="hoverable hoverable-flat w-full text-left px-3 py-2.5"
              style={{
                background: job.id === selectedId ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'transparent',
                borderLeft: `2px solid ${job.id === selectedId ? 'var(--accent)' : 'transparent'}`,
                borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)',
              }}
            >
              <div className="text-sm truncate">{job.description}</div>
              <div className="text-xs mt-0.5 flex items-center gap-1" style={{ color: STATUS_COLOR[job.status] ?? 'var(--muted)' }}>
                {ACTIVE_STATUSES.has(job.status) && <span className="animate-pulse">●</span>}
                {STATUS_LABEL[job.status] ?? job.status}
              </div>
            </button>
          ))}
        </div>
        )}
        {llm && configured && <SettingsPanel state={llm} onChange={setLlm} />}
      </div>

      {/* ── main column ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col gap-3">
        {selected ? (
          <JobWorkbench key={selected.id} job={selected} busy={busy} onAct={act} onChanged={() => void refresh()} />
        ) : (
          <div
            className="flex-1 rounded-lg grid place-items-center text-sm text-center px-8"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            Describe a strategy below — the AI analyzes it, you confirm, it writes and validates the code, you review and approve.
          </div>
        )}
        <InputZone
          job={selected}
          busy={busy || creating}
          error={error}
          onAct={act}
          onCreate={createJob}
          onNew={() => { setSelectedId(null); setError('') }}
        />
      </div>
    </div>
  )
}

// ── LLM settings (rail footer, or the whole rail until configured) ───────────

/** Model suggestions per provider — a datalist, so anything else still types. */
const MODEL_SUGGESTIONS: Record<string, string[]> = {
  anthropic: ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  'anthropic-compatible': ['claude-sonnet-5', 'claude-haiku-4-5-20251001', 'kimi-k2-thinking'],
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'o3'],
  'openai-compatible': ['deepseek-chat', 'deepseek-reasoner', 'qwen-plus', 'qwen3-coder-plus', 'moonshot-v1-32k', 'glm-4.5'],
  google: ['gemini-2.5-pro', 'gemini-2.5-flash'],
}

interface LlmSettingsState {
  model: string
  credentialName: string
  /** What the server holds — "configured" is judged on this, not on what is being typed. */
  saved: { model: string; credentialName: string }
  credentials: Array<{ name: string; type: string }>
  llmTypes: string[]
}

function useLlmSettings() {
  const [state, setState] = useState<LlmSettingsState | null>(null)
  useEffect(() => {
    void (async () => {
      const [settingsRes, credsRes, typesRes] = await Promise.all([
        fetch('/api/compiler/settings'), fetch('/api/credentials'), fetch('/api/credential-types'),
      ])
      const settings = settingsRes.ok ? await settingsRes.json() as { model: string; credentialName?: string } : { model: '' }
      const credentials = credsRes.ok ? await credsRes.json() as Array<{ name: string; type: string }> : []
      const types = typesRes.ok ? await typesRes.json() as Array<{ type: string; category?: string }> : []
      setState({
        model: settings.model ?? '',
        credentialName: settings.credentialName ?? '',
        saved: { model: settings.model ?? '', credentialName: settings.credentialName ?? '' },
        credentials,
        llmTypes: types.filter(t => t.category === 'AI Provider').map(t => t.type),
      })
    })()
  }, [])
  return [state, setState] as const
}

/** Configured = a model is set AND some credential of its provider exists. */
function llmConfigured(state: LlmSettingsState | null): boolean {
  if (!state || !state.saved.model) return false
  const provider = state.saved.model.split(':')[0] ?? ''
  const modelName = state.saved.model.slice(provider.length + 1)
  if (!modelName) return false
  return state.credentials.some(c => c.type === provider && (!state.saved.credentialName || c.name === state.saved.credentialName))
}

function SettingsPanel({ state, onChange, centered }: {
  state: LlmSettingsState
  onChange: (next: LlmSettingsState) => void
  centered?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState('')
  const llmCredentials = state.credentials.filter(c => state.llmTypes.includes(c.type))
  const chosen = llmCredentials.find(c => c.name === state.credentialName)
  // Provider follows the chosen credential; the model field is just the model name
  const provider = chosen?.type ?? (state.model.split(':')[0] || '')
  const modelName = state.model.includes(':') ? state.model.slice(state.model.indexOf(':') + 1) : state.model
  const suggestions = MODEL_SUGGESTIONS[provider] ?? []

  function setCredential(name: string) {
    const cred = llmCredentials.find(c => c.name === name)
    const nextProvider = cred?.type ?? provider
    onChange({ ...state, credentialName: name, model: nextProvider ? `${nextProvider}:${modelName}` : modelName })
  }
  function setModelName(value: string) {
    onChange({ ...state, model: provider ? `${provider}:${value}` : value })
  }

  async function save() {
    setStatus('')
    const res = await fetch('/api/compiler/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: state.model, ...(state.credentialName ? { credentialName: state.credentialName } : {}) }),
    })
    setStatus(res.ok ? '✓ saved' : await res.text())
    if (res.ok) onChange({ ...state, saved: { model: state.model, credentialName: state.credentialName } })
  }

  const fields = (
    <div className="flex flex-col gap-2 text-sm">
      <select
        value={state.credentialName}
        onChange={(e) => setCredential(e.target.value)}
        className="rounded-md px-2 py-1.5 text-xs w-full"
        style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
      >
        <option value="">{llmCredentials.length === 0 ? 'No LLM credential — add one on Credentials' : 'Choose an LLM credential…'}</option>
        {llmCredentials.map(c => <option key={c.name} value={c.name}>{c.name} · {c.type}</option>)}
      </select>
      <div className="flex gap-2">
        <input
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
          list="ow-llm-models"
          disabled={!provider}
          placeholder={provider ? `model for ${provider}` : 'pick a credential first'}
          className="rounded-md px-2.5 py-1.5 font-mono text-xs flex-1 min-w-0"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', opacity: provider ? 1 : 0.6 }}
        />
        <datalist id="ow-llm-models">
          {suggestions.map(m => <option key={m} value={m} />)}
        </datalist>
        <button onClick={() => void save()} disabled={!provider || !modelName} className="px-3 py-1.5 rounded-md text-xs shrink-0" style={{ background: 'var(--accent)', color: '#fff', opacity: !provider || !modelName ? 0.5 : 1 }}>
          Save
        </button>
      </div>
      {status && <span className="text-xs truncate" style={{ color: status.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>{status}</span>}
    </div>
  )

  if (centered) {
    return (
      <div className="flex-1 min-h-0 grid place-items-center p-4">
        <div className="w-full flex flex-col gap-3">
          <div className="text-center">
            <div className="text-sm font-medium">Set up the compiler LLM</div>
            <div className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Pick a credential, then the model it should drive.</div>
          </div>
          {fields}
        </div>
      </div>
    )
  }

  return (
    <div className="shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
      <button onClick={() => setOpen(v => !v)} className="w-full text-left px-3 py-2.5 text-xs flex justify-between items-center" style={{ color: 'var(--muted)' }}>
        <span className="truncate font-semibold">LLM · {state.model || '…'}</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="px-3 pb-3">{fields}</div>}
    </div>
  )
}

// ── Workbench: code | agent chat, side by side ───────────────────────────────

type ViewMode = 'code' | 'split' | 'chat'

function JobWorkbench({ job, busy, onAct, onChanged }: {
  job: CompileJob
  busy: boolean
  onAct: (body: Record<string, unknown>) => Promise<void>
  onChanged: () => void
}) {
  const version = job.versions.at(-1)
  const [activeFile, setActiveFile] = useState(0)
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [view, setView] = useState<ViewMode>(() => {
    try { return (localStorage.getItem('ow.compiler.view') as ViewMode) || 'split' } catch { return 'split' }
  })
  const [splitPct, setSplitPct] = useState<number>(() => {
    try { return Number(localStorage.getItem('ow.compiler.split')) || 58 } catch { return 58 }
  })
  const areaRef = useRef<HTMLDivElement>(null)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!maximized) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMaximized(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized])

  const files = version?.files ?? []
  const file = files[Math.min(activeFile, Math.max(files.length - 1, 0))]
  const dirty = Object.keys(editing).length > 0
  const validation = version?.validation
  // No code yet → the chat is the whole story
  const effectiveView: ViewMode = version ? view : 'chat'

  function pickView(v: ViewMode) {
    setView(v)
    try { localStorage.setItem('ow.compiler.view', v) } catch { /* private mode */ }
  }

  function startDrag(e: React.MouseEvent) {
    e.preventDefault()
    const area = areaRef.current
    if (!area) return
    const rect = area.getBoundingClientRect()
    const move = (ev: MouseEvent) => {
      const pct = Math.min(80, Math.max(20, ((ev.clientX - rect.left) / rect.width) * 100))
      setSplitPct(pct)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setSplitPct(p => { try { localStorage.setItem('ow.compiler.split', String(Math.round(p))) } catch { /* private mode */ } return p })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  function revalidateEdits() {
    const merged: DraftFile[] = files.map(f => ({ ...f, code: editing[`${f.kind}/${f.id}`] ?? f.code }))
    setEditing({})
    void onAct({ action: 'code', files: merged })
  }

  const showCode = effectiveView !== 'chat'
  const showChat = effectiveView !== 'code'

  return (
    <div
      className="flex-1 min-h-0 flex flex-col rounded-lg overflow-hidden"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* toolbar */}
      <div className="flex items-center gap-1 px-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        {showCode && KIND_ORDER.flatMap(kind => files
          .map((f, i) => ({ f, i }))
          .filter(({ f }) => f.kind === kind)
          .map(({ f, i }) => {
            const color = KIND_COLOR[kind] ?? 'var(--accent)'
            const active = i === activeFile
            return (
              <button
                key={`${f.kind}/${f.id}`}
                onClick={() => setActiveFile(i)}
                className="px-2.5 py-2 text-xs flex items-center gap-1.5"
                style={{
                  color: active ? 'var(--foreground)' : 'var(--muted)',
                  borderBottom: `2px solid ${active ? color : 'transparent'}`,
                  marginBottom: '-1px',
                }}
                title={`${f.kind}/${f.id}.ts${f.kind === 'executors' ? ' — write-capable code, review line by line' : ''}`}
              >
                <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: color }} />
                <span className="font-medium">{KIND_LABEL[kind] ?? kind}</span>
                <span className="font-mono opacity-70">{f.id}</span>
                {f.kind === 'executors' && <span style={{ color: 'var(--danger)' }}>⚠</span>}
                {editing[`${f.kind}/${f.id}`] !== undefined && <span style={{ color }}>•</span>}
              </button>
            )
          }))}
        {!showCode && (
          <span className="px-1 py-2 text-xs font-semibold" style={{ color: 'var(--muted)' }}>
            {ACTIVE_STATUSES.has(job.status) && <span className="animate-pulse" style={{ color: 'var(--accent)' }}>● </span>}
            AGENT · {STATUS_LABEL[job.status] ?? job.status}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 py-1.5">
          {validation && (
            <span
              className="text-[11px] px-2 py-0.5 rounded-full"
              style={validation.passed
                ? { background: 'var(--success-soft)', color: 'var(--success)' }
                : { background: 'var(--danger-soft)', color: 'var(--danger)' }}
              title={validation.passed ? 'L1–L4 validation passed' : validation.issues.map(i => `[${i.level}] ${i.message}`).join('\n')}
            >
              {validation.passed ? '✓ L1–L4' : `✗ ${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'}`}
            </span>
          )}
          {dirty && (
            <button onClick={revalidateEdits} disabled={busy} className="text-xs px-2.5 py-1 rounded-md" style={{ border: '1px solid var(--accent)', color: 'var(--foreground)' }}>
              Re-validate edits
            </button>
          )}
          {version && (
            <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
              {([['code', 'Code'], ['split', 'Split'], ['chat', 'Chat']] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => pickView(key)}
                  className="text-[11px] px-2 py-1"
                  style={{
                    background: view === key ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
                    color: view === key ? 'var(--foreground)' : 'var(--muted)',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {version && (
            <button
              onClick={() => setMaximized(true)}
              title="Maximize the editor (Esc to return)"
              className="text-xs px-2 py-1 rounded-md"
              style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
            >
              ⤢
            </button>
          )}
          <button
            onClick={() => void fetch(`/api/compiler/jobs/${job.id}`, { method: 'DELETE' }).then(onChanged)}
            className="text-xs px-2 py-1 rounded-md"
            style={{ color: 'var(--danger)', border: '1px solid var(--border)' }}
          >
            Delete
          </button>
        </div>
      </div>

      {/* maximized editor: file tree + the same models, full viewport */}
      {maximized && file && (
        <div className="fixed inset-0 z-50 flex" style={{ background: 'var(--background)' }}>
          <aside className="w-60 shrink-0 flex flex-col" style={{ borderRight: '1px solid var(--border)', background: 'var(--surface)' }}>
            <div className="px-3 py-2.5 text-xs font-semibold" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
              {job.description.length > 28 ? `${job.description.slice(0, 28)}…` : job.description}
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden py-2">
              {KIND_ORDER.filter(kind => files.some(f => f.kind === kind)).map(kind => (
                <div key={kind} className="mb-2">
                  <div className="px-3 py-1 text-[11px] font-mono flex items-center gap-1.5" style={{ color: 'var(--muted)' }}>
                    <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: KIND_COLOR[kind] }} />
                    {kind}/
                  </div>
                  {files.map((f, i) => ({ f, i })).filter(({ f }) => f.kind === kind).map(({ f, i }) => (
                    <button
                      key={`${f.kind}/${f.id}`}
                      onClick={() => setActiveFile(i)}
                      className="hoverable hoverable-flat w-full text-left pl-7 pr-3 py-1 text-xs font-mono truncate"
                      style={{
                        color: i === activeFile ? 'var(--foreground)' : 'var(--muted)',
                        background: i === activeFile ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'transparent',
                      }}
                    >
                      {f.id}.ts{editing[`${f.kind}/${f.id}`] !== undefined ? ' •' : ''}
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted)', borderTop: '1px solid var(--border)' }}>
              Edits are type-checked live; Re-validate runs L1–L4.
            </div>
          </aside>
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex items-center gap-2 px-3 shrink-0" style={{ height: 40, borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
              <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: KIND_COLOR[file.kind] }} />
              <span className="text-xs font-mono">{file.kind}/{file.id}.ts</span>
              {file.kind === 'executors' && <span className="text-xs" style={{ color: 'var(--danger)' }}>⚠ write-capable</span>}
              <div className="ml-auto flex items-center gap-2">
                {validation && (
                  <span
                    className="text-[11px] px-2 py-0.5 rounded-full"
                    style={validation.passed
                      ? { background: 'var(--success-soft)', color: 'var(--success)' }
                      : { background: 'var(--danger-soft)', color: 'var(--danger)' }}
                    title={validation.passed ? 'L1–L4 validation passed' : validation.issues.map(i => `[${i.level}] ${i.message}`).join('\n')}
                  >
                    {validation.passed ? '✓ L1–L4' : `✗ ${validation.issues.length} issue${validation.issues.length === 1 ? '' : 's'}`}
                  </span>
                )}
                {dirty && (
                  <button onClick={revalidateEdits} disabled={busy} className="text-xs px-2.5 py-1 rounded-md" style={{ border: '1px solid var(--accent)', color: 'var(--foreground)' }}>
                    Re-validate edits
                  </button>
                )}
                <button
                  onClick={() => setMaximized(false)}
                  title="Return to the workbench (Esc)"
                  className="text-xs px-2 py-1 rounded-md"
                  style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
                >
                  ⤡ Esc
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <CodeEditor
                path={`${job.id}/${file.kind}/${file.id}.ts`}
                value={editing[`${file.kind}/${file.id}`] ?? file.code}
                onChange={(code) => {
                  const key = `${file.kind}/${file.id}`
                  setEditing(prev => code === file.code
                    ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key))
                    : { ...prev, [key]: code })
                }}
                readOnly={ACTIVE_STATUSES.has(job.status)}
              />
            </div>
          </div>
        </div>
      )}

      {/* code | divider | chat */}
      <div ref={areaRef} className="flex-1 min-h-0 flex">
        {showCode && file && (
          <div className="min-w-0 min-h-0" style={{ flexBasis: showChat ? `${splitPct}%` : '100%', flexGrow: 0, flexShrink: 0 }}>
            <CodeEditor
              path={`${job.id}/${file.kind}/${file.id}.ts`}
              value={editing[`${file.kind}/${file.id}`] ?? file.code}
              onChange={(code) => {
                const key = `${file.kind}/${file.id}`
                setEditing(prev => code === file.code
                  ? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== key))
                  : { ...prev, [key]: code })
              }}
              readOnly={ACTIVE_STATUSES.has(job.status)}
            />
          </div>
        )}
        {showCode && showChat && file && (
          <div
            onMouseDown={startDrag}
            className="shrink-0 group cursor-col-resize grid place-items-center"
            style={{ width: 8, background: 'var(--border)' }}
            title="Drag to resize"
          >
            <div className="w-0.5 h-8 rounded-full" style={{ background: 'var(--muted)', opacity: 0.6 }} />
          </div>
        )}
        {showChat && (
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <AgentLog job={job} />
          </div>
        )}
      </div>
    </div>
  )
}

// ── Agent conversation (chat history + analysis + live activity) ─────────────

function AgentLog({ job }: { job: CompileJob }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const live = ACTIVE_STATUSES.has(job.status)

  const entries = useMemo(() => {
    const out: Array<{ key: string; kind: 'user' | 'assistant' | 'activity' | 'error'; text: string; ts?: string }> = []
    for (let i = 0; i < job.messages.length; i++) {
      const m = job.messages[i]!
      out.push({ key: `m${i}`, kind: m.role, text: m.content, ts: m.ts })
    }
    if (live && (job.progress?.length ?? 0) > 0) {
      const recent = job.progress!.slice(-8)
      out.push({ key: 'progress', kind: 'activity', text: recent.map(p => p.message).join('\n') })
    }
    if (job.error) out.push({ key: 'err', kind: 'error', text: job.error })
    return out
  }, [job, live])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries])

  return (
    <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scroll-hidden p-3 flex flex-col gap-2" style={{ borderLeft: '1px solid var(--border)' }}>
      {job.analysis && <AnalysisCard analysis={job.analysis} />}
      {entries.map(entry => (
        <div
          key={entry.key}
          className={`max-w-[90%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${entry.kind === 'user' ? 'self-end' : 'self-start'}`}
          style={entry.kind === 'user'
            ? { background: 'color-mix(in srgb, var(--accent) 18%, transparent)', border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)' }
            : entry.kind === 'error'
              ? { background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)' }
              : entry.kind === 'activity'
                ? { background: 'transparent', color: 'var(--muted)', border: '1px dashed var(--border)', fontFamily: 'var(--font-mono, monospace)', fontSize: '11px' }
                : { background: 'color-mix(in srgb, var(--border) 25%, transparent)', border: '1px solid var(--border)' }}
        >
          {entry.text}
        </div>
      ))}
    </div>
  )
}

function AnalysisCard({ analysis }: { analysis: NonNullable<CompileJob['analysis']> }) {
  return (
    <div className="self-start max-w-[95%] rounded-lg px-3 py-2 text-sm flex flex-col gap-1.5" style={{ background: 'color-mix(in srgb, var(--border) 25%, transparent)', border: '1px solid var(--border)' }}>
      <span className="text-[11px] font-semibold" style={{ color: 'var(--muted)' }}>ANALYSIS</span>
      <p className="whitespace-pre-wrap">{analysis.summary}</p>
      <div className="text-xs flex flex-col gap-0.5" style={{ color: 'var(--muted)' }}>
        {analysis.reuse.monitors.map(m => <span key={m.id}>↺ monitor <b>{m.id}</b> — {m.reason}</span>)}
        {analysis.reuse.executors.map(e => <span key={e.id}>↺ executor <b>{e.id}</b> ({e.actions.join(', ')}) — {e.reason}</span>)}
        {analysis.reuse.accounts.map(a => <span key={a.label}>↺ reader <b>{a.readerClass}</b> ({a.kind}) as &apos;{a.label}&apos;</span>)}
        {analysis.generate.monitors.map(m => <span key={m.id} style={{ color: 'var(--warning)' }}>+ NEW monitor <b>{m.id}</b> — {m.justification}</span>)}
        {analysis.generate.executors.map(e => <span key={e.id} style={{ color: 'var(--danger)' }}>+ NEW EXECUTOR <b>{e.id}</b> — {e.justification}</span>)}
        <span>Triggers: {analysis.triggers}</span>
        <span>Params: {analysis.params}</span>
        {analysis.gaps.map((g, i) => <span key={i} style={{ color: 'var(--warning)' }}>⚠ gap: {g}</span>)}
      </div>
    </div>
  )
}

// ── Input box: one place to talk — create, confirm, iterate, approve ─────────

/** Starter prompts for an empty session — a chip fills the box, Enter sends. */
const EXAMPLES: Array<{ label: string; prompt: string }> = [
  { label: 'Ladder the dip', prompt: 'Every 5 minutes check BTC perp. Place a ladder of 5 limit buys below the current price, each 2% apart, 0.01 BTC per level. When a level fills, place a take-profit sell 1.5% above its entry. Cancel every open order if price falls 15% below the lowest level.' },
  { label: 'Chase the funding', prompt: 'Watch Binance funding rates every minute. When a perp\'s funding is above 0.05% per 8h and settlement is within 30 minutes, open a short 2 minutes before settlement and close it 1 minute after, sized to 5% of equity.' },
  { label: 'Trailing exit', prompt: 'Check my ETH perp position every minute. Track the highest price since entry; market-close the whole position if price drops 3% from that high, or if unrealized PnL is below -2%.' },
  { label: 'Webhook signals', prompt: 'Build a monitor that receives TradingView-style webhook alerts with {symbol, side, size}, and a strategy that turns each alert into a market order on my Hyperliquid account, ignoring duplicates within 60 seconds.' },
  { label: 'Ask the model', prompt: 'Every hour summarize the last 24h of BTC klines and funding with the LLM; if it judges the trend as strongly bullish with high confidence, open a small long (1% of equity) with a 2% stop.' },
]

function InputZone({ job, busy, error, onAct, onCreate }: {
  job: CompileJob | null
  busy: boolean
  error: string
  onAct: (body: Record<string, unknown>) => Promise<void>
  onCreate: (description: string) => Promise<void>
  onNew: () => void
}) {
  const [text, setText] = useState('')
  const [ack, setAck] = useState(false)
  const version = job?.versions.at(-1)
  const hasExecutor = version?.files.some(f => f.kind === 'executors') ?? false

  const creating = job === null
  const confirming = !!job && (job.status === 'awaiting_confirmation' || (job.status === 'failed' && job.versions.length === 0))
  // A registered strategy is not a finished conversation — feedback keeps
  // flowing; the next version lands as a draft to approve again.
  const iterating = !!job && (job.status === 'draft' || job.status === 'approved' || (job.status === 'failed' && job.versions.length > 0))
  // Only a session the agent is still working on has nothing to say back.
  if (!creating && !confirming && !iterating) return error ? <ErrorLine text={error} /> : null

  function send() {
    const t = text.trim()
    if (creating) {
      if (!t) return
      setText('')
      void onCreate(t)
    } else if (confirming) {
      setText('')
      void onAct({ action: 'confirm', ...(t ? { note: t } : {}) })
    } else if (iterating && t) {
      setText('')
      void onAct({ action: 'message', feedback: t })
    }
  }

  const label = creating ? 'Your request' : confirming ? (job.status === 'failed' ? 'Retry — corrections (optional)' : 'Corrections (optional) — send to confirm & generate') : 'Feedback'
  const placeholder = creating
    ? 'Describe a strategy in natural language…'
    : confirming
      ? 'Anything the analysis got wrong? Send empty to confirm as-is.'
      : job.status === 'approved'
        ? 'Registered — keep iterating; the next version becomes a draft to approve again'
        : 'Iterate in natural language, e.g. "make the take-profit threshold a parameter"'
  const canSend = !busy && (confirming || text.trim().length > 0)

  const chip = (labelText: string, onClick: () => void, opts: { active?: boolean; danger?: boolean; disabled?: boolean; title?: string } = {}) => (
    <button
      key={labelText}
      onClick={onClick}
      disabled={opts.disabled}
      title={opts.title}
      className="hoverable px-3 py-1 rounded-full text-xs whitespace-nowrap"
      style={{
        border: `1px solid ${opts.active ? 'var(--accent)' : opts.danger ? 'color-mix(in srgb, var(--danger) 50%, transparent)' : 'var(--border)'}`,
        background: opts.active ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : opts.danger ? 'var(--danger-soft)' : 'transparent',
        color: opts.danger ? 'var(--danger)' : opts.active ? 'var(--foreground)' : 'var(--muted)',
        opacity: opts.disabled ? 0.45 : 1,
      }}
    >
      {labelText}
    </button>
  )

  return (
    <div className="shrink-0 flex flex-col gap-2">
      {error && <ErrorLine text={error} />}
      <div className="rounded-xl p-3 flex flex-col gap-2.5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <div className="px-1 text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: 'var(--muted)' }}>{label}</div>
        {/* the input proper: its own bordered field, three rows, the send
            button sitting inside it on the right */}
        <div className="relative">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
            rows={3}
            placeholder={placeholder}
            className="scroll-hidden w-full rounded-lg px-3.5 py-2.5 text-sm resize-none outline-none leading-relaxed"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', paddingRight: '3.75rem' }}
          />
          <button
            onClick={send}
            disabled={!canSend}
            title={creating ? 'Compile (Enter)' : confirming ? 'Confirm & Generate (Enter)' : 'Send (Enter)'}
            aria-label="Send"
            className="absolute right-3 top-1/2 -translate-y-1/2 grid place-items-center rounded-full"
            style={{
              width: 32, height: 32,
              background: canSend ? 'var(--accent)' : 'transparent',
              color: canSend ? '#fff' : 'var(--muted)',
              border: `1px solid ${canSend ? 'var(--accent)' : 'var(--border)'}`,
            }}
          >
            {busy
              ? <span className="animate-pulse text-xs">…</span>
              : <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z" /></svg>}
          </button>
        </div>
      <div className="flex flex-wrap gap-1.5 px-0.5">
        {creating && EXAMPLES.map(ex => chip(ex.label, () => setText(ex.prompt), { active: text === ex.prompt }))}
        {iterating && (
          <>
            {job.status === 'failed' && version && chip('Re-validate', () => void onAct({ action: 'code', files: version.files }), { disabled: busy, title: 'Re-run the validation ladder without calling the LLM' })}
            {job.status === 'draft' && hasExecutor && chip(ack ? '✓ Executor reviewed line by line' : 'I have reviewed the EXECUTOR line by line', () => setAck(v => !v), { danger: !ack, active: ack })}
            {job.status === 'draft' && chip('Approve & Register', () => void onAct({ action: 'approve', ...(hasExecutor ? { acknowledgeExecutorRisk: ack } : {}) }), { active: true, disabled: busy || (hasExecutor && !ack) })}
          </>
        )}
        </div>
      </div>
    </div>
  )
}

function ErrorLine({ text }: { text: string }) {
  return <p className="shrink-0 text-xs px-3 py-2 rounded-md whitespace-pre-wrap" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>{text}</p>
}
