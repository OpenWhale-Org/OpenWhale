'use client'

import { useState, useEffect, useCallback } from 'react'
import type { CompileJob, DraftFile } from '@openwhaleorg/compiler'
import { subscribeLiveEvents } from '@/lib/live-events'

const ACTIVE_STATUSES = new Set(['analyzing', 'generating', 'validating'])

const STATUS_LABEL: Record<string, string> = {
  analyzing: 'Analyzing…',
  awaiting_confirmation: 'Awaiting your confirmation',
  generating: 'Generating code…',
  validating: 'Validating…',
  draft: 'Draft ready for review',
  failed: 'Failed',
  approved: 'Approved & registered',
}

// ── Compiler LLM settings card ────────────────────────────────────────────────

function SettingsCard() {
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
    <div className="rounded-lg p-4 flex flex-col gap-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <button onClick={() => setOpen(v => !v)} className="text-left text-xs font-semibold flex justify-between" style={{ color: 'var(--muted)' }}>
        <span>COMPILER LLM · {model || '…'}{credentialName ? ` · ${credentialName}` : ''}</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="flex flex-wrap gap-2 items-end text-sm">
          <div className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: 'var(--muted)' }}>Model (provider:model)</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="anthropic:claude-sonnet-5"
              className="rounded-md px-3 py-2 font-mono text-sm w-72"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: 'var(--muted)' }}>Credential</label>
            <select value={credentialName} onChange={(e) => setCredentialName(e.target.value)}
              className="rounded-md px-3 py-2 text-sm"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
              <option value="">{matching.length === 1 ? `auto (${matching[0]!.name})` : matching.length === 0 ? `none of type "${provider}" — add one on Credentials` : 'choose…'}</option>
              {matching.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </div>
          <button onClick={() => void save()} className="px-4 py-2 rounded-md text-sm" style={{ background: 'var(--accent)', color: '#fff' }}>Save</button>
          {status && <span className="text-xs" style={{ color: status.startsWith('✓') ? '#4ade80' : 'var(--danger)' }}>{status}</span>}
        </div>
      )}
    </div>
  )
}

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

  // SSE-driven refresh: any compiler event refetches the job list
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
    <div className="flex flex-col gap-4">
      <SettingsCard />
      <form onSubmit={createJob} className="rounded-lg p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
          Describe your strategy in natural language — the AI analyzes it, you confirm, it writes and validates the code, you review and approve.
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="e.g. Check my BTC perp position every minute; market-close half above +5% PnL, close everything below -3%"
          className="rounded-md px-3 py-2 text-sm resize-y"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        />
        <div className="flex items-center gap-2 self-end">
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="rounded-md px-2 py-2 text-sm"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            <option value="auto">auto (usually strategy)</option>
            <option value="strategy">strategy only</option>
            <option value="monitor">monitor only</option>
            <option value="executor">executor only</option>
            <option value="suite">full suite</option>
          </select>
          <button
            type="submit"
            disabled={creating || !description.trim()}
            className="px-4 py-2 rounded-md text-sm"
            style={{ background: 'var(--accent)', color: '#fff', opacity: creating ? 0.6 : 1 }}
          >
            {creating ? 'Starting…' : 'Compile'}
          </button>
        </div>
      </form>

      <div className="flex gap-4 items-start">
        {/* Job list */}
        <div className="w-64 shrink-0 flex flex-col gap-2">
          {jobs.length === 0 && (
            <p className="text-sm p-4 text-center" style={{ color: 'var(--muted)' }}>No compile jobs yet.</p>
          )}
          {jobs.map(job => (
            <button
              key={job.id}
              onClick={() => setSelectedId(job.id)}
              className="rounded-md p-3 text-left text-sm"
              style={{
                background: job.id === selectedId ? 'var(--surface)' : 'var(--background)',
                border: `1px solid ${job.id === selectedId ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              <div className="truncate">{job.description}</div>
              <div className="text-xs mt-1 flex items-center gap-1" style={{ color: 'var(--muted)' }}>
                {ACTIVE_STATUSES.has(job.status) && <span className="animate-pulse">●</span>}
                {STATUS_LABEL[job.status] ?? job.status}
              </div>
            </button>
          ))}
        </div>

        {/* Job detail */}
        <div className="flex-1 min-w-0">
          {selected ? <JobDetail job={selected} onChanged={() => void refresh()} /> : null}
        </div>
      </div>
    </div>
  )
}

// ── Job detail ────────────────────────────────────────────────────────────────

function JobDetail({ job, onChanged }: { job: CompileJob; onChanged: () => void }) {
  const [note, setNote] = useState('')
  const [feedback, setFeedback] = useState('')
  const [ack, setAck] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Record<string, string>>({})

  const version = job.versions.at(-1)
  const hasExecutor = version?.files.some(f => f.kind === 'executors') ?? false

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{STATUS_LABEL[job.status] ?? job.status}</span>
        <button
          onClick={() => void fetch(`/api/compiler/jobs/${job.id}`, { method: 'DELETE' }).then(onChanged)}
          className="text-xs px-2 py-1 rounded" style={{ color: 'var(--danger)', border: '1px solid var(--border)' }}
        >
          Delete job
        </button>
      </div>

      {job.error && (
        <p className="text-xs px-3 py-2 rounded-md whitespace-pre-wrap" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{job.error}</p>
      )}

      {/* Live pipeline activity — streamed over SSE, persisted on the job */}
      {(job.progress?.length ?? 0) > 0 && (ACTIVE_STATUSES.has(job.status) || job.status === 'failed') && (
        <ProgressLog
          entries={job.progress!}
          live={ACTIVE_STATUSES.has(job.status)}
        />
      )}

      {/* Analysis confirmation card */}
      {job.analysis && (
        <div className="rounded-lg p-4 flex flex-col gap-2 text-sm" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>ANALYSIS</span>
          <p className="whitespace-pre-wrap">{job.analysis.summary}</p>
          <div className="text-xs flex flex-col gap-1" style={{ color: 'var(--muted)' }}>
            {job.analysis.reuse.monitors.map(m => <span key={m.id}>↺ monitor <b>{m.id}</b> — {m.reason}</span>)}
            {job.analysis.reuse.executors.map(e => <span key={e.id}>↺ executor <b>{e.id}</b> ({e.actions.join(', ')}) — {e.reason}</span>)}
            {job.analysis.reuse.accounts.map(a => <span key={a.label}>↺ reader <b>{a.readerClass}</b> ({a.kind}) as '{a.label}'</span>)}
            {job.analysis.generate.monitors.map(m => <span key={m.id} style={{ color: 'var(--warning)' }}>+ NEW monitor <b>{m.id}</b> — {m.justification}</span>)}
            {job.analysis.generate.executors.map(e => <span key={e.id} style={{ color: 'var(--danger)' }}>+ NEW EXECUTOR <b>{e.id}</b> — {e.justification}</span>)}
            <span>Triggers: {job.analysis.triggers}</span>
            <span>Params: {job.analysis.params}</span>
            {job.analysis.gaps.map((g, i) => <span key={i} style={{ color: 'var(--warning)' }}>⚠ gap: {g}</span>)}
          </div>
          {(job.status === 'awaiting_confirmation' || (job.status === 'failed' && job.versions.length === 0)) && (
            <div className="flex gap-2 items-end mt-1">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Corrections (optional)"
                className="flex-1 rounded-md px-3 py-2 text-sm"
                style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              />
              <button
                onClick={() => void act({ action: 'confirm', ...(note.trim() ? { note: note.trim() } : {}) })}
                disabled={busy}
                className="px-4 py-2 rounded-md text-sm"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                {job.status === 'failed' ? 'Retry Generate' : 'Confirm & Generate'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Latest draft */}
      {version && (
        <div className="rounded-lg p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
          <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>
            DRAFT v{version.seq} · {version.origin === 'initial' ? 'initial generation' : version.origin === 'manual-edit' ? 'manual edit' : `feedback: ${version.origin.slice(0, 60)}`}
          </span>

          <p className="text-sm whitespace-pre-wrap">{version.explanation}</p>

          {version.validation && !version.validation.passed && (
            <div className="text-xs px-3 py-2 rounded-md flex flex-col gap-1" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
              {version.validation.issues.map((issue, i) => (
                <span key={i}>[{issue.level}] {issue.file ? `${issue.file}: ` : ''}{issue.message}</span>
              ))}
            </div>
          )}

          {version.validation?.passed && version.validation.dryRunInstructions && version.validation.dryRunInstructions.length > 0 && (
            <div className="text-xs px-3 py-2 rounded-md" style={{ background: '#1a3a24', color: '#4ade80' }}>
              ✓ Validated (L1–L4). Dry-run emitted: {version.validation.dryRunInstructions.map((i, k) => (
                <code key={k} className="ml-1">{i.action}({JSON.stringify(i.params)})</code>
              ))}
            </div>
          )}

          {version.files.map(file => (
            <FileView
              key={`${file.kind}/${file.id}`}
              file={file}
              edited={editing[`${file.kind}/${file.id}`]}
              onEdit={(code) => setEditing(prev => ({ ...prev, [`${file.kind}/${file.id}`]: code }))}
            />
          ))}

          {Object.keys(editing).length > 0 && (
            <button
              onClick={() => {
                const files: DraftFile[] = version.files.map(f => ({ ...f, code: editing[`${f.kind}/${f.id}`] ?? f.code }))
                setEditing({})
                void act({ action: 'code', files })
              }}
              disabled={busy}
              className="self-start px-4 py-2 rounded-md text-sm"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--accent)' }}
            >
              Re-validate my edits
            </button>
          )}

          {/* Iterate + approve */}
          {(job.status === 'draft' || job.status === 'failed') && (
            <div className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              <div className="flex gap-2">
                <input
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder='Iterate in natural language, e.g. "make the take-profit threshold a parameter"'
                  className="flex-1 rounded-md px-3 py-2 text-sm"
                  style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                />
                <button
                  onClick={() => { const f = feedback.trim(); if (f) { setFeedback(''); void act({ action: 'message', feedback: f }) } }}
                  disabled={busy || !feedback.trim()}
                  className="px-4 py-2 rounded-md text-sm"
                  style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                >
                  Send
                </button>
                {job.status === 'failed' && (
                  <button
                    onClick={() => void act({ action: 'code', files: version.files })}
                    disabled={busy}
                    title="Re-run the validation ladder on the current code without calling the LLM"
                    className="px-4 py-2 rounded-md text-sm"
                    style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--accent)' }}
                  >
                    Re-validate
                  </button>
                )}
              </div>

              {job.status === 'draft' && (
                <div className="flex flex-col gap-2">
                  {hasExecutor && (
                    <label className="flex items-start gap-2 text-xs px-3 py-2 rounded-md cursor-pointer" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
                      <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
                      This draft contains a generated EXECUTOR — code that will hold write-capable trading sessions.
                      I have reviewed it line by line. (Recommended: bind mock/testnet credentials for its first runs;
                      going straight to mainnet is allowed but on you.)
                    </label>
                  )}
                  <button
                    onClick={() => void act({ action: 'approve', ...(hasExecutor ? { acknowledgeExecutorRisk: ack } : {}) })}
                    disabled={busy || (hasExecutor && !ack)}
                    className="self-start px-4 py-2 rounded-md text-sm"
                    style={{ background: 'var(--accent)', color: '#fff', opacity: busy || (hasExecutor && !ack) ? 0.5 : 1 }}
                  >
                    Approve & Register
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs px-3 py-2 rounded-md whitespace-pre-wrap" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</p>
      )}
    </div>
  )
}

function ProgressLog({ entries, live }: { entries: Array<{ ts: string; message: string }>; live: boolean }) {
  const shown = entries.slice(-30)
  return (
    <div className="rounded-lg p-3 flex flex-col gap-1 font-mono text-xs" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <span className="font-semibold mb-1" style={{ color: 'var(--muted)' }}>
        {live ? <span className="animate-pulse">● </span> : null}PIPELINE ACTIVITY
      </span>
      {shown.map((entry, i) => (
        <div key={`${entry.ts}-${i}`} className="flex gap-2" style={{ color: i === shown.length - 1 && live ? 'var(--foreground)' : 'var(--muted)' }}>
          <span className="shrink-0 opacity-60">{new Date(entry.ts).toLocaleTimeString()}</span>
          <span className="break-all">{entry.message}</span>
        </div>
      ))}
    </div>
  )
}

function FileView({ file, edited, onEdit }: { file: DraftFile; edited?: string; onEdit: (code: string) => void }) {
  const [open, setOpen] = useState(file.kind === 'strategies')
  return (
    <div className="rounded-md" style={{ border: '1px solid var(--border)' }}>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full text-left px-3 py-2 text-xs font-mono flex justify-between"
        style={{ color: file.kind === 'executors' ? 'var(--danger)' : 'var(--foreground)' }}
      >
        <span>{file.kind}/{file.id}.ts{file.kind === 'executors' ? '  ⚠ write-capable' : ''}</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <textarea
          value={edited ?? file.code}
          onChange={(e) => onEdit(e.target.value)}
          rows={Math.min(30, (edited ?? file.code).split('\n').length + 1)}
          spellCheck={false}
          className="w-full px-3 py-2 text-xs font-mono resize-y"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: 'none', borderTop: '1px solid var(--border)' }}
        />
      )}
    </div>
  )
}
