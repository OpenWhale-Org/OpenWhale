'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Select } from '@/components/Select'
import { Switch } from '@/components/Switch'
import { KebabMenu, MENU_ITEM } from '@/components/CardMenu'
import { useT } from '@/i18n'

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

function formatWhen(iso: string | undefined, never: string): string {
  return iso ? new Date(iso).toLocaleString() : never
}

export function RetentionClient() {
  const t = useT()
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
      if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? t('retention.saveFailed')); return }
      const { policy } = await res.json() as { policy: Policy }
      if (andRun) await run(policy.id)
      else { setNotice(t('retention.saved', { monitor: policy.monitor, pattern: policy.keyPattern, days: policy.keepDays })); await load() }
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
      if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? t('retention.runFailed')); return }
      const { summaries } = await res.json() as { summaries: RunSummary[] }
      const freed = summaries.reduce((n, s) => n + s.bytesFreed, 0)
      const dropped = summaries.reduce((n, s) => n + s.droppedRecords, 0)
      const errs = summaries.flatMap(s => s.errors)
      setNotice(dropped === 0 ? t('retention.nothingToPrune')
        : t('retention.freed', { bytes: formatBytes(freed), records: dropped.toLocaleString(), files: summaries.reduce((n, s) => n + s.files, 0) }))
      if (errs.length) setError(errs.join(' · '))
      await load()
    } finally { setBusy('') }
  }

  async function remove(id: string) {
    if (!confirm(t('retention.deleteConfirm'))) return
    await fetch(`/api/monitor-retention/${encodeURIComponent(id)}`, { method: 'DELETE' })
    await load()
  }

  const options = useMemo(() => [
    { value: '*', label: t('retention.everyMonitor'), hint: t('retention.allStores') },
    ...contracts.map(c => ({ value: c.monitor, label: c.monitor, hint: t('retention.keysBytes', { n: c.keys, bytes: formatBytes(c.bytes) }) })),
  ], [contracts, t])

  const collected = contracts.reduce((n, c) => n + c.bytes, 0)
  const matchedBytes = (matched ?? []).reduce((n, m) => n + m.bytes, 0)

  return (
    <div className="flex flex-col gap-3">
      {/* Totals and free space: the same question asked twice. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          {t('retention.monitors')} <span style={{ color: 'var(--foreground)' }}>{formatBytes(collected)}</span>
          {disk && <> · {t('retention.disk')} <span style={{ color: 'var(--foreground)' }}>{formatBytes(disk.freeBytes)}</span> {t('retention.free')}</>}
        </span>
        <button
          onClick={() => void run()}
          disabled={busy !== '' || policies.filter(p => p.enabled).length === 0}
          className="text-xs px-3 py-1.5 rounded-md"
          style={{ border: '1px solid var(--border)', color: 'var(--muted)', opacity: busy ? 0.6 : 1 }}
          title={t('retention.runAllTitle')}
        >
          {busy === 'all' ? t('retention.running') : t('retention.runAll')}
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
            <span>{t('retention.policies', { n: policies.length })}</span>
            <span>{t('retention.sweptHourly')}</span>
          </div>
          <div className="flex-1 overflow-y-auto scroll-hidden">
            {policies.length === 0 && (
              <p className="text-xs px-3 py-4" style={{ color: 'var(--muted)' }}>
                {t('retention.noPolicies')}
              </p>
            )}
            {policies.map(p => (
              <div key={p.id} className="hoverable px-3 py-2.5 flex items-start gap-2" style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-mono truncate" title={`${p.monitor} / ${p.keyPattern}`}>
                    {p.monitor} <span style={{ color: 'var(--muted)' }}>/</span> {p.keyPattern}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>
                    {t('retention.policyLine', { days: p.keepDays, when: formatWhen(p.lastRunAt, t('retention.never')) })}
                    {p.lastResult && p.lastResult.files > 0 && t('retention.freedShort', { bytes: formatBytes(p.lastResult.bytesFreed) })}
                  </div>
                  {p.lastResult?.errors.length ? (
                    <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--danger, #ef4444)' }} title={p.lastResult.errors.join('\n')}>
                      {t('retention.errors', { n: p.lastResult.errors.length })}
                    </div>
                  ) : null}
                </div>
                <Switch checked={p.enabled} onChange={next => { void fetch('/api/monitor-retention', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p, enabled: next }) }).then(load) }} />
                <KebabMenu>
                  {close => (
                    <>
                      <button className={MENU_ITEM} onClick={() => { close(); setDraft({ id: p.id, monitor: p.monitor, keyPattern: p.keyPattern, keepDays: p.keepDays, enabled: p.enabled }) }}>{t('common.edit')}</button>
                      <button className={MENU_ITEM} onClick={() => { close(); void run(p.id) }}>{t('retention.runNow')}</button>
                      <button className={MENU_ITEM} style={{ color: 'var(--danger, #ef4444)' }} onClick={() => { close(); void remove(p.id) }}>{t('common.delete')}</button>
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
            {draft.id ? t('retention.editPolicy') : t('retention.newPolicy')}
          </div>
          <div className="flex-1 overflow-y-auto scroll-hidden p-3 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('retention.monitor')}</span>
              <Select value={draft.monitor} options={options} placeholder={t('retention.pickMonitor')} onChange={v => setDraft(d => ({ ...d, monitor: v }))} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('retention.keyPattern')}</span>
              <input
                value={draft.keyPattern}
                onChange={e => setDraft(d => ({ ...d, keyPattern: e.target.value }))}
                placeholder="*"
                className="text-xs font-mono px-2 py-1.5 rounded-md w-full"
                style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)' }}
              />
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                <code>*</code> {t('retention.patternStar')} <code>?</code> {t('retention.patternQ')}
              </span>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('retention.keepLast')}</span>
              <div className="flex items-center gap-2">
                <input
                  type="number" min={0.5} step={0.5} value={draft.keepDays}
                  onChange={e => setDraft(d => ({ ...d, keepDays: Number(e.target.value) }))}
                  className="text-xs px-2 py-1.5 rounded-md"
                  style={{ background: 'var(--background)', border: '1px solid var(--border)', color: 'var(--foreground)', width: 96 }}
                />
                <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('retention.daysOlderDropped')}</span>
              </div>
            </label>

            {/* The dry run. Records with no readable ts are kept, so this is a
                floor on what survives, never an over-estimate of what goes. */}
            {draft.monitor && (
              <div className="rounded-md p-2.5 text-xs" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
                {previewing && <span style={{ color: 'var(--muted)' }}>{t('retention.measuring')}</span>}
                {!previewing && preview && (
                  <>
                    <div>
                      {t('retention.matchesPrefix')} <span style={{ color: 'var(--foreground)' }}>{matched?.length ?? 0}</span>{' '}
                      {t('retention.matchesSuffix', { bytes: formatBytes(matchedBytes) })}
                    </div>
                    <div className="mt-1">
                      {preview.droppedRecords === 0
                        ? <span style={{ color: 'var(--muted)' }}>{t('retention.nothingOlder')}</span>
                        : <>{t('retention.wouldDrop')} <span style={{ color: 'var(--danger, #ef4444)' }}>{preview.droppedRecords.toLocaleString()}</span> {t('retention.wouldDropMid', { files: preview.files })} <span style={{ color: 'var(--accent)' }}>{formatBytes(preview.bytesFreed)}</span>{t('retention.wouldDropEnd')}</>}
                    </div>
                    {matched && matched.length > 0 && (
                      <div className="mt-2 flex flex-col gap-0.5" style={{ maxHeight: '7rem', overflowY: 'auto' }}>
                        {matched.slice(0, 40).map(m => (
                          <div key={`${m.monitor}/${m.key}`} className="flex justify-between gap-3 font-mono" style={{ color: 'var(--muted)' }}>
                            <span className="truncate" title={`${m.monitor}/${m.key}`}>{m.monitor}/{m.key}</span>
                            <span className="shrink-0">{formatBytes(m.bytes)}</span>
                          </div>
                        ))}
                        {matched.length > 40 && <span style={{ color: 'var(--muted)' }}>{t('retention.more', { n: matched.length - 40 })}</span>}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            <Switch checked={draft.enabled} onChange={v => setDraft(d => ({ ...d, enabled: v }))} label={t('retention.enabled')} hint={t('retention.hourlyHint')} />
          </div>

          <div className="px-3 py-2.5 shrink-0 flex items-center gap-2" style={{ borderTop: '1px solid var(--border)' }}>
            <button
              onClick={() => void save(false)}
              disabled={!draft.monitor || !(draft.keepDays > 0) || busy !== ''}
              className="text-xs px-3 py-1.5 rounded-md"
              style={{ background: 'var(--accent)', color: '#fff', opacity: !draft.monitor || busy ? 0.5 : 1 }}
            >
              {draft.id ? t('retention.saveChanges') : t('retention.addPolicy')}
            </button>
            <button
              onClick={() => void save(true)}
              disabled={!draft.monitor || !(draft.keepDays > 0) || busy !== ''}
              className="text-xs px-3 py-1.5 rounded-md"
              style={{ border: '1px solid var(--border)', color: 'var(--muted)', opacity: !draft.monitor || busy ? 0.5 : 1 }}
            >
              {t('retention.saveRun')}
            </button>
            {draft.id && (
              <button onClick={() => setDraft({ ...BLANK })} className="text-xs px-3 py-1.5 rounded-md" style={{ color: 'var(--muted)' }}>
                {t('common.cancel')}
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
          <span>{t('retention.runHistory')}</span>
          <span>{t('retention.runHistoryHint')}</span>
        </div>
        <div className="flex-1 overflow-y-auto scroll-hidden">
          {runs.length === 0 && (
            <p className="text-xs px-3 py-4" style={{ color: 'var(--muted)' }}>
              {t('retention.nothingPruned')}
            </p>
          )}
          {runs.length > 0 && (
            <table className="w-full text-xs" style={{ minWidth: '40rem' }}>
              <thead>
                <tr style={{ color: 'var(--muted)' }}>
                  <th className="text-left font-medium px-3 py-1.5">{t('retention.col.when')}</th>
                  <th className="text-left font-medium py-1.5">{t('retention.col.target')}</th>
                  <th className="text-right font-medium py-1.5">{t('retention.col.kept')}</th>
                  <th className="text-right font-medium py-1.5">{t('retention.col.files')}</th>
                  <th className="text-right font-medium py-1.5">{t('retention.col.records')}</th>
                  <th className="text-right font-medium py-1.5 pr-3">{t('retention.col.freed')}</th>
                  <th className="text-left font-medium py-1.5 pr-3">{t('retention.col.by')}</th>
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
                      {r.trigger === 'manual' ? t('retention.trigger.manual') : t('retention.trigger.scheduled')}{r.errors.length ? ` · ${t('retention.errors', { n: r.errors.length })}` : ''}
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
