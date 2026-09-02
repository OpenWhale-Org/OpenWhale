'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Select } from '@/components/Select'
import { Switch } from '@/components/Switch'
import { KebabMenu, MENU_ITEM } from '@/components/CardMenu'

interface ContractEntry { monitor: string; keys: number; bytes: number }
interface MatchedFile { monitor: string; key: string; bytes: number; updatedAt: number }
interface RunSummary { at: string; files: number; droppedRecords: number; bytesFreed: number; errors: string[] }
interface RetentionRun extends RunSummary {
  id: number
  policyId: string
  monitor: string
  keyPattern: string
  keepDays: number
  trigger: 'scheduled' | 'manual'
}
interface Policy {
  id: string
  monitor: string
  keyPattern: string
  keepDays: number
  enabled: boolean
  lastRunAt?: string
  lastResult?: RunSummary
}

type Draft = Pick<Policy, 'monitor' | 'keyPattern' | 'keepDays' | 'enabled'> & { id?: string }

const panelStyle = { background: 'var(--surface)', border: '1px solid var(--border)' } as const
const BLANK: Draft = { monitor: '', keyPattern: '*', keepDays: 30, enabled: true }

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

function formatWhen(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : 'never'
}

export function RetentionClient() {
  const [contracts, setContracts] = useState<ContractEntry[]>([])
  const [disk, setDisk] = useState<{ freeBytes: number; totalBytes: number } | null>(null)
  const [policies, setPolicies] = useState<Policy[]>([])
  const [draft, setDraft] = useState<Draft>(BLANK)
  const [matched, setMatched] = useState<MatchedFile[] | null>(null)
  const [preview, setPreview] = useState<RunSummary | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [runs, setRuns] = useState<RetentionRun[]>([])

  const load = useCallback(async () => {
    const [dataRes, polRes, runRes] = await Promise.all([
      fetch('/api/monitor-data'),
      fetch('/api/monitor-retention'),
      fetch('/api/monitor-retention/runs?limit=100'),
    ])
    if (dataRes.ok) {
      const d = await dataRes.json() as { contracts: ContractEntry[]; disk?: { freeBytes: number; totalBytes: number } }
      setContracts(d.contracts.sort((a, b) => b.bytes - a.bytes))
      setDisk(d.disk ?? null)
    }
    if (polRes.ok) setPolicies(((await polRes.json()) as { policies: Policy[] }).policies)
    if (runRes.ok) setRuns(((await runRes.json()) as { runs: RetentionRun[] }).runs)
  }, [])

  useEffect(() => { void load() }, [load])

  /*
   * The preview is the whole point of the editor: "keep 7 days" means nothing
   * until you can see it is about to drop 5.4GB out of a store you meant to
   * keep. It is a dry run on the server, so it is safe to fire while typing —
   * but it walks every matched file, so debounce it and drop stale answers.
   */
  const seq = useRef(0)
  useEffect(() => {
    if (!draft.monitor || !(draft.keepDays > 0)) { setMatched(null); setPreview(null); return }
    const mine = ++seq.current
    setPreviewing(true)
    const t = setTimeout(() => {
      void fetch('/api/monitor-retention/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monitor: draft.monitor, keyPattern: draft.keyPattern, keepDays: draft.keepDays }),
      })
        .then(async r => (r.ok ? r.json() as Promise<{ matched: MatchedFile[]; summary: RunSummary }> : null))
        .then(d => {
          if (mine !== seq.current) return
          setMatched(d?.matched ?? [])
          setPreview(d?.summary ?? null)
        })
        .finally(() => { if (mine === seq.current) setPreviewing(false) })
    }, 350)
    return () => clearTimeout(t)
  }, [draft.monitor, draft.keyPattern, draft.keepDays])

  async function save(andRun: boolean) {
    setError(''); setNotice(''); setBusy('save')
    try {
      const res = await fetch('/api/monitor-retention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      })
      if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? 'save failed'); return }
      const { policy } = await res.json() as { policy: Policy }
      if (andRun) await run(policy.id)
      else { setNotice(`Saved — ${policy.monitor} / ${policy.keyPattern}, keep ${policy.keepDays}d`); await load() }
      setDraft({ ...BLANK })
    } finally { setBusy('') }
  }

  async function run(id?: string) {
    setError(''); setNotice(''); setBusy(id ?? 'all')
    try {
      const res = await fetch('/api/monitor-retention/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(id ? { id } : {}),
      })
      if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? 'run failed'); return }
      const { summaries } = await res.json() as { summaries: RunSummary[] }
      const freed = summaries.reduce((n, s) => n + s.bytesFreed, 0)
      const dropped = summaries.reduce((n, s) => n + s.droppedRecords, 0)
      const errs = summaries.flatMap(s => s.errors)
      setNotice(dropped === 0 ? 'Nothing to prune — everything matched is inside its horizon.'
        : `Freed ${formatBytes(freed)} — ${dropped.toLocaleString()} records across ${summaries.reduce((n, s) => n + s.files, 0)} files.`)
      if (errs.length) setError(errs.join(' · '))
      await load()
    } finally { setBusy('') }
  }

  async function remove(id: string) {
    if (!confirm('Delete this retention policy? Data already pruned does not come back.')) return
    await fetch(`/api/monitor-retention/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  const options = useMemo(() => [
    { value: '*', label: 'Every monitor', hint: 'all stores below' },
    ...contracts.map(c => ({ value: c.monitor, label: c.monitor, hint: `${c.keys} keys · ${formatBytes(c.bytes)}` })),
  ], [contracts])

  const collected = contracts.reduce((n, c) => n + c.bytes, 0)
  const matchedBytes = (matched ?? []).reduce((n, m) => n + m.bytes, 0)

  return (
    <div className="flex flex-col gap-3">
      {/* Totals and free space: the same question asked twice. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          monitors <span style={{ color: 'var(--foreground)' }}>{formatBytes(collected)}</span>
          {disk && <> · disk <span style={{ color: 'var(--foreground)' }}>{formatBytes(disk.freeBytes)}</span> free</>}
        </span>
        <button
          onClick={() => void run()}
          disabled={busy !== '' || policies.filter(p => p.enabled).length === 0}
          className="text-xs px-3 py-1.5 rounded-md"
          style={{ border: '1px solid var(--border)', color: 'var(--muted)', opacity: busy ? 0.6 : 1 }}
          title="Run every enabled policy now, without waiting for the hourly sweep"
        >
          {busy === 'all' ? 'Running…' : '⟳ Run all now'}
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-md text-xs" style={{ background: 'color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)', color: 'var(--danger, #ef4444)' }}>
          {error}
        </div>
      )}
      {notice && (
        <div className="px-3 py-2 rounded-md text-xs" style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}>
          {notice}
        </div>
      )}

      <div className="grid gap-3" style={{ gridTemplateColumns: 'minmax(300px, 1fr) minmax(360px, 1.35fr)' }}>
        {/* ── saved policies ─────────────────────────────────────────────── */}
        <div className="rounded-lg flex flex-col" style={{ ...panelStyle, height: '30rem' }}>
          <div className="px-3 py-2 text-xs font-medium shrink-0 flex items-center justify-between" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
            <span>Policies ({policies.length})</span>
            <span>swept hourly</span>
          </div>
          <div className="flex-1 overflow-y-auto scroll-hidden">
            {policies.length === 0 && (
              <p className="text-xs px-3 py-4" style={{ color: 'var(--muted)' }}>
                No policies yet — nothing is being pruned. Build one on the right.
              </p>
            )}
            {policies.map(p => (
              <div key={p.id} className="hoverable px-3 py-2.5 flex items-start gap-2" style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono truncate" title={`${p.monitor} / ${p.keyPattern}`}>
                    {p.monitor} <span style={{ color: 'var(--muted)' }}>/</span> {p.keyPattern}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                    keep {p.keepDays}d · last run {formatWhen(p.lastRunAt)}
                    {p.lastResult && p.lastResult.files > 0 && <> · freed {formatBytes(p.lastResult.bytesFreed)}</>}
                  </div>
                  {p.lastResult?.errors.length ? (
                    <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--danger, #ef4444)' }} title={p.lastResult.errors.join('\n')}>
                      {p.lastResult.errors.length} error(s)
                    </div>
                  ) : null}
                </div>
                <Switch checked={p.enabled} onChange={next => { void fetch('/api/monitor-retention', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, enabled: next }) }).then(load) }} />
                <KebabMenu>
                  {close => (
                    <>
                      <button className={MENU_ITEM} onClick={() => { close(); setDraft({ id: p.id, monitor: p.monitor, keyPattern: p.keyPattern, keepDays: p.keepDays, enabled: p.enabled }) }}>Edit</button>
                      <button className={MENU_ITEM} onClick={() => { close(); void run(p.id) }}>Run now</button>
                      <button className={MENU_ITEM} style={{ color: 'var(--danger, #ef4444)' }} onClick={() => { close(); void remove(p.id) }}>Delete</button>
                    </>
                  )}
                </KebabMenu>
              </div>
            ))}
          </div>
        </div>

        {/* ── editor ─────────────────────────────────────────────────────── */}
        <div className="rounded-lg flex flex-col" style={{ ...panelStyle, height: '30rem' }}>
          <div className="px-3 py-2 text-xs font-medium shrink-0" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
            {draft.id ? 'Edit policy' : 'New policy'}
          </div>
          <div className="flex-1 overflow-y-auto scroll-hidden p-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>Monitor</span>
              <Select value={draft.monitor} options={options} placeholder="Pick a monitor" onChange={v => setDraft(d => ({ ...d, monitor: v }))} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>Key pattern</span>
              <input
                value={draft.keyPattern}
                onChange={e => setDraft(d => ({ ...d, keyPattern: e.target.value }))}
                placeholder="*"
                className="text-xs font-mono px-2 py-1.5 rounded-md w-full"
                style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                <code>*</code> spans any characters, <code>?</code> exactly one. Everything else is literal.
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>Keep the last</span>
              <div className="flex items-center gap-2">
                <input
                  type="number" min={0.5} step={0.5} value={draft.keepDays}
                  onChange={e => setDraft(d => ({ ...d, keepDays: Number(e.target.value) }))}
                  className="text-xs px-2 py-1.5 rounded-md"
                  style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)', width: 96 }}
                />
                <span className="text-xs" style={{ color: 'var(--muted)' }}>days — older records are dropped</span>
              </div>
            </label>

            {/* The dry run. Records with no readable ts are kept, so this is a
                floor on what survives, never an over-estimate of what goes. */}
            {draft.monitor && (
              <div className="rounded-md p-2.5 text-xs" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
                {previewing && <span style={{ color: 'var(--muted)' }}>Measuring…</span>}
                {!previewing && preview && (
                  <>
                    <div>
                      Matches <span style={{ color: 'var(--foreground)' }}>{matched?.length ?? 0}</span> file(s),{' '}
                      {formatBytes(matchedBytes)} on disk.
                    </div>
                    <div className="mt-1">
                      {preview.droppedRecords === 0
                        ? <span style={{ color: 'var(--muted)' }}>Nothing older than the horizon — this would free nothing today.</span>
                        : <>Would drop <span style={{ color: 'var(--danger, #ef4444)' }}>{preview.droppedRecords.toLocaleString()}</span> records from {preview.files} file(s), freeing <span style={{ color: 'var(--accent)' }}>{formatBytes(preview.bytesFreed)}</span>.</>}
                    </div>
                    {matched && matched.length > 0 && (
                      <div className="mt-2 flex flex-col gap-0.5" style={{ maxHeight: '7rem', overflowY: 'auto' }}>
                        {matched.slice(0, 40).map(m => (
                          <div key={`${m.monitor}/${m.key}`} className="flex justify-between gap-3 font-mono" style={{ color: 'var(--muted)' }}>
                            <span className="truncate" title={`${m.monitor}/${m.key}`}>{m.monitor}/{m.key}</span>
                            <span className="shrink-0">{formatBytes(m.bytes)}</span>
                          </div>
                        ))}
                        {matched.length > 40 && <span style={{ color: 'var(--muted)' }}>+{matched.length - 40} more…</span>}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <Switch checked={draft.enabled} onChange={v => setDraft(d => ({ ...d, enabled: v }))} label="Enabled" hint="Included in the hourly sweep" />
          </div>

          <div className="px-3 py-2.5 shrink-0 flex items-center gap-2" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              onClick={() => void save(false)}
              disabled={!draft.monitor || !(draft.keepDays > 0) || busy !== ''}
              className="text-xs px-3 py-1.5 rounded-md"
              style={{ background: 'var(--accent)', color: '#fff', opacity: !draft.monitor || busy ? 0.5 : 1 }}
            >
              {draft.id ? 'Save changes' : 'Add policy'}
            </button>
            <button
              onClick={() => void save(true)}
              disabled={!draft.monitor || !(draft.keepDays > 0) || busy !== ''}
              className="text-xs px-3 py-1.5 rounded-md"
              style={{ border: '1px solid var(--border)', color: 'var(--muted)', opacity: !draft.monitor || busy ? 0.5 : 1 }}
            >
              Save &amp; run now
            </button>
            {draft.id && (
              <button onClick={() => setDraft({ ...BLANK })} className="text-xs px-3 py-1.5 rounded-md" style={{ color: 'var(--muted)' }}>
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── run history ────────────────────────────────────────────────────
          Only passes that actually deleted something land here; a sweep that
          found nothing to do is not an event. "Still running at all" is
          answered by each policy's last-run line above. */}
      <div className="rounded-lg flex flex-col" style={{ ...panelStyle, maxHeight: '22rem' }}>
        <div className="px-3 py-2 text-xs font-medium shrink-0 flex items-center justify-between" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
          <span>Run history</span>
          <span>passes that deleted something · newest first</span>
        </div>
        <div className="flex-1 overflow-y-auto scroll-hidden">
          {runs.length === 0 && (
            <p className="text-xs px-3 py-4" style={{ color: 'var(--muted)' }}>
              Nothing pruned yet.
            </p>
          )}
          {runs.length > 0 && (
            <table className="w-full text-xs" style={{ minWidth: '40rem' }}>
              <thead>
                <tr style={{ color: 'var(--muted)' }}>
                  <th className="text-left font-medium px-3 py-1.5">When</th>
                  <th className="text-left font-medium py-1.5">Target</th>
                  <th className="text-right font-medium py-1.5">Kept</th>
                  <th className="text-right font-medium py-1.5">Files</th>
                  <th className="text-right font-medium py-1.5">Records</th>
                  <th className="text-right font-medium py-1.5 pr-3">Freed</th>
                  <th className="text-left font-medium py-1.5 pr-3">By</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className="hoverable" style={{ borderTop: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                    <td className="px-3 py-1.5 whitespace-nowrap">{new Date(r.at).toLocaleString()}</td>
                    <td className="py-1.5 font-mono truncate" style={{ maxWidth: 260 }} title={`${r.monitor} / ${r.keyPattern}`}>
                      {r.monitor} <span style={{ color: 'var(--muted)' }}>/</span> {r.keyPattern}
                    </td>
                    <td className="py-1.5 text-right font-mono" style={{ color: 'var(--muted)' }}>{r.keepDays}d</td>
                    <td className="py-1.5 text-right font-mono">{r.files}</td>
                    <td className="py-1.5 text-right font-mono">{r.droppedRecords.toLocaleString()}</td>
                    <td className="py-1.5 text-right font-mono pr-3" style={{ color: 'var(--accent)' }}>{formatBytes(r.bytesFreed)}</td>
                    <td className="py-1.5 pr-3" style={{ color: r.errors.length ? 'var(--danger, #ef4444)' : 'var(--muted)' }}
                        title={r.errors.join('\n')}>
                      {r.trigger}{r.errors.length ? ` · ${r.errors.length} error(s)` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
