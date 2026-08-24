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
  approved: 'Approved & registered',
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
        <SettingsPanel />
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

// ── LLM settings (rail footer) ────────────────────────────────────────────────

function SettingsPanel() {
  const [model, setModel] = useState('')
  const [credentialName, setCredentialName] = useState('')
  const [credentials, setCredentials] = useState<Array<{ name: string; type: string }>>([])
  const [status, setStatus] = useState('')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void fetch('/api/compiler/settings').then(async (res) => {
      if (!res.ok) return
      const s = await res.json() as { model: string; credentialName?: string }
      setModel(s.model)
      setCredentialName(s.credentialName ?? '')
    })
    void fetch('/api/credentials').then(async (res) => {
      if (res.ok) setCredentials(await res.json() as Array<{ name: string; type: string }>)
    })
  }, [])

  const provider = model.split(':')[0] ?? ''
  const matching = credentials.filter(c => c.type === provider)

  async function save() {
    setStatus('')
    const res = await fetch('/api/compiler/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...(credentialName ? { credentialName } : {}) }),
    })
    setStatus(res.ok ? '✓ saved' : await res.text())
  }

  return (
    <div className="shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
      <button onClick={() => setOpen(v => !v)} className="w-full text-left px-3 py-2.5 text-xs flex justify-between items-center" style={{ color: 'var(--muted)' }}>
        <span className="truncate font-semibold">LLM · {model || '…'}</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 flex flex-col gap-2 text-sm">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="anthropic:claude-sonnet-5"
            className="rounded-md px-2.5 py-1.5 font-mono text-xs"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
          <select value={credentialName} onChange={(e) => setCredentialName(e.target.value)}
            className="rounded-md px-2 py-1.5 text-xs"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
            <option value="">{matching.length === 1 ? `auto (${matching[0]!.name})` : matching.length === 0 ? `no "${provider}" credential` : 'choose credential…'}</option>
            {matching.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
          </select>
          <div className="flex items-center gap-2">
            <button onClick={() => void save()} className="px-3 py-1.5 rounded-md text-xs" style={{ background: 'var(--accent)', color: '#fff' }}>Save</button>
            {status && <span className="text-xs truncate" style={{ color: status.startsWith('✓') ? 'var(--success)' : 'var(--danger)' }}>{status}</span>}
          </div>
        </div>
      )}
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
                readOnly={job.status === 'approved' || ACTIVE_STATUSES.has(job.status)}
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
              readOnly={job.status === 'approved' || ACTIVE_STATUSES.has(job.status)}
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
  const iterating = !!job && (job.status === 'draft' || (job.status === 'failed' && job.versions.length > 0))
  // Settled or busy sessions have nothing to say back — no box at all; the
  // rail's "+ New" is where the next conversation starts.
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

  const placeholder = creating
    ? 'Describe a strategy in natural language — Enter to compile, Shift+Enter for a new line'
    : confirming
      ? 'Corrections to the analysis (optional) — then Confirm & Generate'
      : 'Iterate in natural language, e.g. "make the take-profit threshold a parameter"'

  const primary = (label: string, onClick: () => void, disabled: boolean) => (
    <button onClick={onClick} disabled={disabled} className="px-3.5 py-1.5 rounded-md text-sm" style={{ background: 'var(--accent)', color: '#fff', opacity: disabled ? 0.5 : 1 }}>
      {label}
    </button>
  )
  const secondary = (label: string, onClick: () => void, disabled: boolean, accent = false, title?: string) => (
    <button onClick={onClick} disabled={disabled} title={title} className="px-3 py-1.5 rounded-md text-sm" style={{ border: `1px solid ${accent ? 'var(--accent)' : 'var(--border)'}`, color: 'var(--foreground)', opacity: disabled ? 0.5 : 1 }}>
      {label}
    </button>
  )

  return (
    <div className="shrink-0 flex flex-col gap-2">
      {error && <ErrorLine text={error} />}
      <div
        className="relative rounded-lg flex flex-col"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', minHeight: creating ? '7.5rem' : '5.5rem' }}
      >
        {iterating && hasExecutor && job.status === 'draft' && (
          <label className="flex items-start gap-2 text-xs px-3 py-2 cursor-pointer" style={{ color: 'var(--danger)', borderBottom: '1px solid var(--border)' }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
            This draft contains a generated EXECUTOR — write-capable code. I have reviewed it line by line.
          </label>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={placeholder}
          className="flex-1 w-full bg-transparent px-3 pt-2.5 text-sm resize-none outline-none"
          style={{ color: 'var(--foreground)', paddingBottom: '2.75rem' }}
        />
        {/* actions live INSIDE the box, bottom-right */}
        <div className="absolute right-2 bottom-2 flex gap-2">
          {creating && primary(busy ? 'Starting…' : 'Compile', send, busy || !text.trim())}
          {confirming && primary(job.status === 'failed' ? 'Retry Generate' : 'Confirm & Generate', send, busy)}
          {iterating && (
            <>
              {job.status === 'failed' && version && secondary('Re-validate', () => void onAct({ action: 'code', files: version.files }), busy, true, 'Re-run the validation ladder without calling the LLM')}
              {secondary('Send', send, busy || !text.trim())}
              {job.status === 'draft' && primary('Approve & Register', () => void onAct({ action: 'approve', ...(hasExecutor ? { acknowledgeExecutorRisk: ack } : {}) }), busy || (hasExecutor && !ack))}
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
