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

const TARGETS = [
  ['auto', 'Auto'],
  ['strategy', 'Strategy'],
  ['monitor', 'Monitor'],
  ['executor', 'Executor'],
  ['suite', 'Suite'],
] as const

export function CompilerClient({ initialJobs }: { initialJobs: CompileJob[] }) {
  const [jobs, setJobs] = useState(initialJobs)
  const [selectedId, setSelectedId] = useState<string | null>(initialJobs[0]?.id ?? null)
  const [description, setDescription] = useState('')
  const [target, setTarget] = useState('auto')
  const [creating, setCreating] = useState(false)

  const refresh = useCallback(async () => {
    const res = await fetch('/api/compiler/jobs')
    if (res.ok) setJobs(await res.json() as CompileJob[])
  }, [])

  useEffect(() => subscribeLiveEvents((event) => {
    if ((event as { type?: string }).type === 'compiler') void refresh()
  }), [refresh])

  async function createJob(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    try {
      const res = await fetch('/api/compiler/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, target }),
      })
      if (res.ok) {
        const job = await res.json() as CompileJob
        setDescription('')
        setSelectedId(job.id)
        await refresh()
      }
    } finally {
      setCreating(false)
    }
  }

  const selected = jobs.find(j => j.id === selectedId) ?? null

  return (
    <div className="flex gap-3" style={{ height: 'calc(100vh - 13rem)', minHeight: 520 }}>
      {/* ── sessions rail ─────────────────────────────────────────────────── */}
      <div
        className="flex flex-col rounded-lg overflow-hidden shrink-0"
        style={{ width: '17rem', background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div className="px-3 py-2.5 text-xs font-semibold shrink-0" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
          SESSIONS
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
          {jobs.length === 0 && (
            <p className="text-xs px-3 py-6 text-center" style={{ color: 'var(--muted)' }}>
              No compile sessions yet — describe a strategy on the right.
            </p>
          )}
          {jobs.map(job => (
            <button
              key={job.id}
              onClick={() => setSelectedId(job.id)}
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
        {/* compile zone */}
        <form
          onSubmit={createJob}
          className="rounded-lg p-3 flex flex-col gap-2 shrink-0"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Describe a strategy in natural language — the AI analyzes it, you confirm, it writes and validates the code, you review and approve."
            className="rounded-md px-3 py-2 text-sm resize-none"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1">
              {TARGETS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTarget(key)}
                  className="px-2.5 py-1 rounded-md text-xs"
                  style={{
                    background: target === key ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
                    color: target === key ? 'var(--foreground)' : 'var(--muted)',
                    border: `1px solid ${target === key ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="submit"
              disabled={creating || !description.trim()}
              className="px-4 py-1.5 rounded-md text-sm"
              style={{ background: 'var(--accent)', color: '#fff', opacity: creating || !description.trim() ? 0.5 : 1 }}
            >
              {creating ? 'Starting…' : 'Compile'}
            </button>
          </div>
        </form>

        {selected ? (
          <JobWorkbench key={selected.id} job={selected} onChanged={() => void refresh()} />
        ) : (
          <div
            className="flex-1 rounded-lg grid place-items-center text-sm"
            style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            Pick a session, or compile something new.
          </div>
        )}
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

// ── Workbench: code zone + agent conversation + input box ─────────────────────

function JobWorkbench({ job, onChanged }: { job: CompileJob; onChanged: () => void }) {
  const version = job.versions.at(-1)
  const [activeFile, setActiveFile] = useState(0)
  const [editing, setEditing] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const files = version?.files ?? []
  const file = files[Math.min(activeFile, Math.max(files.length - 1, 0))]
  const dirty = Object.keys(editing).length > 0

  async function act(body: Record<string, unknown>) {
    setBusy(true)
    setError('')
    const res = await fetch(`/api/compiler/jobs/${job.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    if (!res.ok) setError(await res.text())
    else onChanged()
  }

  function revalidateEdits() {
    const merged: DraftFile[] = files.map(f => ({ ...f, code: editing[`${f.kind}/${f.id}`] ?? f.code }))
    setEditing({})
    void act({ action: 'code', files: merged })
  }

  const validation = version?.validation

  return (
    <>
      {/* code zone */}
      {version && (
        <div
          className={`${expanded ? 'flex-1' : 'flex-[3]'} min-h-0 flex flex-col rounded-lg overflow-hidden`}
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-1 px-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            {files.map((f, i) => (
              <button
                key={`${f.kind}/${f.id}`}
                onClick={() => setActiveFile(i)}
                className="px-2.5 py-2 text-xs font-mono"
                style={{
                  color: f.kind === 'executors' ? 'var(--danger)' : i === activeFile ? 'var(--foreground)' : 'var(--muted)',
                  borderBottom: i === activeFile ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: '-1px',
                }}
                title={f.kind === 'executors' ? 'Write-capable code — review line by line' : undefined}
              >
                {f.kind}/{f.id}.ts{f.kind === 'executors' ? ' ⚠' : ''}{editing[`${f.kind}/${f.id}`] !== undefined ? ' •' : ''}
              </button>
            ))}
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
              <button
                onClick={() => setExpanded(v => !v)}
                title={expanded ? 'Restore layout' : 'Expand code'}
                className="text-xs px-1.5 py-1 rounded-md"
                style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
              >
                {expanded ? '⇲' : '⇱'}
              </button>
              <button
                onClick={() => void fetch(`/api/compiler/jobs/${job.id}`, { method: 'DELETE' }).then(onChanged)}
                className="text-xs px-2 py-1 rounded-md"
                style={{ color: 'var(--danger)', border: '1px solid var(--border)' }}
              >
                Delete
              </button>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            {file && (
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
            )}
          </div>
        </div>
      )}

      {/* agent conversation */}
      {!expanded && (
        <AgentLog job={job} deletable={!version} onChanged={onChanged} />
      )}

      {/* input box */}
      {!expanded && (
        <InputZone job={job} busy={busy} error={error} onAct={act} hasFiles={files.length > 0} />
      )}
    </>
  )
}

// ── Agent conversation (chat history + analysis + live activity) ─────────────

function AgentLog({ job, deletable, onChanged }: { job: CompileJob; deletable: boolean; onChanged: () => void }) {
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
    <div
      className="flex-[2] min-h-0 flex flex-col rounded-lg overflow-hidden"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="px-3 py-2 text-xs font-semibold shrink-0 flex items-center justify-between" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
        <span>{live && <span className="animate-pulse" style={{ color: 'var(--accent)' }}>● </span>}AGENT · {STATUS_LABEL[job.status] ?? job.status}</span>
        {deletable && (
          <button
            onClick={() => void fetch(`/api/compiler/jobs/${job.id}`, { method: 'DELETE' }).then(onChanged)}
            className="px-2 py-0.5 rounded-md"
            style={{ color: 'var(--danger)', border: '1px solid var(--border)' }}
          >
            Delete
          </button>
        )}
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto scroll-hidden p-3 flex flex-col gap-2">
        {job.analysis && <AnalysisCard analysis={job.analysis} />}
        {entries.map(entry => (
          <div
            key={entry.key}
            className={`max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${entry.kind === 'user' ? 'self-end' : 'self-start'}`}
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

// ── Input box: context-aware actions ─────────────────────────────────────────

function InputZone({ job, busy, error, onAct, hasFiles }: {
  job: CompileJob
  busy: boolean
  error: string
  onAct: (body: Record<string, unknown>) => Promise<void>
  hasFiles: boolean
}) {
  const [text, setText] = useState('')
  const [ack, setAck] = useState(false)
  const version = job.versions.at(-1)
  const hasExecutor = version?.files.some(f => f.kind === 'executors') ?? false

  const confirming = job.status === 'awaiting_confirmation' || (job.status === 'failed' && job.versions.length === 0)
  const iterating = job.status === 'draft' || (job.status === 'failed' && job.versions.length > 0)
  if (!confirming && !iterating && !error) return null

  function send() {
    const t = text.trim()
    if (confirming) {
      setText('')
      void onAct({ action: 'confirm', ...(t ? { note: t } : {}) })
    } else if (t) {
      setText('')
      void onAct({ action: 'message', feedback: t })
    }
  }

  return (
    <div className="shrink-0 rounded-lg p-2.5 flex flex-col gap-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      {error && <p className="text-xs px-2 py-1.5 rounded-md whitespace-pre-wrap" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>{error}</p>}
      {iterating && hasExecutor && job.status === 'draft' && (
        <label className="flex items-start gap-2 text-xs px-2.5 py-1.5 rounded-md cursor-pointer" style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
          This draft contains a generated EXECUTOR — write-capable code. I have reviewed it line by line.
        </label>
      )}
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={confirming
            ? 'Corrections to the analysis (optional) — then Confirm & Generate'
            : 'Iterate in natural language, e.g. "make the take-profit threshold a parameter"'}
          className="flex-1 rounded-md px-3 py-2 text-sm"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        />
        {confirming ? (
          <button onClick={send} disabled={busy} className="px-4 py-2 rounded-md text-sm shrink-0" style={{ background: 'var(--accent)', color: '#fff', opacity: busy ? 0.5 : 1 }}>
            {job.status === 'failed' ? 'Retry Generate' : 'Confirm & Generate'}
          </button>
        ) : (
          <>
            <button onClick={send} disabled={busy || !text.trim()} className="px-3 py-2 rounded-md text-sm shrink-0" style={{ border: '1px solid var(--border)', color: 'var(--foreground)', opacity: busy || !text.trim() ? 0.5 : 1 }}>
              Send
            </button>
            {job.status === 'failed' && hasFiles && (
              <button
                onClick={() => void onAct({ action: 'code', files: version!.files })}
                disabled={busy}
                title="Re-run the validation ladder on the current code without calling the LLM"
                className="px-3 py-2 rounded-md text-sm shrink-0"
                style={{ border: '1px solid var(--accent)', color: 'var(--foreground)' }}
              >
                Re-validate
              </button>
            )}
            {job.status === 'draft' && (
              <button
                onClick={() => void onAct({ action: 'approve', ...(hasExecutor ? { acknowledgeExecutorRisk: ack } : {}) })}
                disabled={busy || (hasExecutor && !ack)}
                className="px-4 py-2 rounded-md text-sm shrink-0"
                style={{ background: 'var(--accent)', color: '#fff', opacity: busy || (hasExecutor && !ack) ? 0.5 : 1 }}
              >
                Approve & Register
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
