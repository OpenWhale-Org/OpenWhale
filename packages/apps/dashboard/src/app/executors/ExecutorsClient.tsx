'use client'

import { useState, useCallback } from 'react'
import type { CredentialInfo, CredentialTypeInfo } from '@openwhaleorg/core'
import { LogsPanel } from '@/components/LogsPanel'
import { JsonModal, CopyButton } from '@/components/JsonModal'

interface ExecutorStatus {
  id: string
  name: string
  description?: string
  supportedActions: string[]
  credentialSlots: Array<{ label: string; kind?: string; type?: string; raw?: boolean }>
  actionSchemas?: Record<string, Record<string, unknown>>
}

interface ExecutionRecord {
  instruction: { action: string; params: Record<string, unknown>; messageId: string; instanceId?: string }
  status: string
  error?: string
  data?: Record<string, unknown>
  executedAt: string
}

interface Props {
  initialExecutors: ExecutorStatus[]
  credentials: CredentialInfo[]
  credentialTypes: CredentialTypeInfo[]
}

function splitId(id: string): { pkg: string; short: string } {
  const idx = id.indexOf('/')
  return idx === -1 ? { pkg: 'core', short: id } : { pkg: id.slice(0, idx), short: id.slice(idx + 1) }
}

export function ExecutorsClient({ initialExecutors, credentials, credentialTypes }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(initialExecutors[0]?.id ?? null)
  const selected = initialExecutors.find(e => e.id === selectedId) ?? null

  const groups = new Map<string, ExecutorStatus[]>()
  for (const e of initialExecutors) {
    const { pkg } = splitId(e.id)
    if (!groups.has(pkg)) groups.set(pkg, [])
    groups.get(pkg)!.push(e)
  }

  return (
    <div className="flex gap-4 items-start">
      {/* ── Left: executors grouped by package ── */}
      <aside className="w-72 shrink-0 flex flex-col gap-4">
        {initialExecutors.length === 0 && (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No executors registered.</p>
        )}
        {[...groups.entries()].map(([pkg, items]) => (
          <div key={pkg} className="flex flex-col gap-1">
            <span className="text-xs font-semibold uppercase px-1" style={{ color: 'var(--muted)' }}>{pkg}</span>
            {items.map((e) => (
              <button
                key={e.id}
                onClick={() => setSelectedId(e.id)}
                className="rounded-md px-3 py-2 text-left"
                style={{
                  background: e.id === selectedId ? 'var(--surface)' : 'transparent',
                  border: `1px solid ${e.id === selectedId ? 'var(--accent)' : 'var(--border)'}`,
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{splitId(e.id).short}</span>
                  {e.credentialSlots.length > 0 && (
                    <span className="text-xs px-1 rounded" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>write</span>
                  )}
                </div>
                {e.description && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--muted)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {e.description}
                  </p>
                )}
              </button>
            ))}
          </div>
        ))}
      </aside>

      {/* ── Right: selected executor detail ── */}
      <main className="flex-1 min-w-0">
        {selected ? (
          <ExecutorDetail key={selected.id} executor={selected} credentials={credentials} credentialTypes={credentialTypes} />
        ) : (
          <p className="text-sm p-8 text-center" style={{ color: 'var(--muted)' }}>Select an executor.</p>
        )}
      </main>
    </div>
  )
}

/** Credentials eligible for a slot: kind slots need a type with a factory for the kind; raw slots need the exact type. */
function eligibleCredentials(
  slot: ExecutorStatus['credentialSlots'][number],
  credentials: CredentialInfo[],
  credentialTypes: CredentialTypeInfo[],
): CredentialInfo[] {
  if (slot.raw) return credentials.filter(c => c.type === slot.type)
  const typesForKind = new Set(credentialTypes.filter(t => slot.kind && t.kinds.includes(slot.kind as never)).map(t => t.type))
  return credentials.filter(c => typesForKind.has(c.type) && (slot.type === undefined || c.type === slot.type))
}

function ExecutorDetail({ executor, credentials, credentialTypes }: {
  executor: ExecutorStatus
  credentials: CredentialInfo[]
  credentialTypes: CredentialTypeInfo[]
}) {
  const [action, setAction] = useState(executor.supportedActions[0] ?? '')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  const [slotCreds, setSlotCreds] = useState<Record<string, string>>({})
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExecutionRecord | null>(null)
  const [error, setError] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const [records, setRecords] = useState<ExecutionRecord[] | null>(null)
  const [recordModal, setRecordModal] = useState<ExecutionRecord | null>(null)

  const schema = executor.actionSchemas?.[action]
  const properties = (schema?.['properties'] ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((schema?.['required'] ?? []) as string[])

  const loadRecords = useCallback(async () => {
    const res = await fetch(`/api/executor/${encodeURIComponent(executor.id)}/records?n=30`)
    if (res.ok) setRecords((await res.json() as ExecutionRecord[]).reverse())
  }, [executor.id])

  async function fire() {
    setBusy(true)
    setError('')
    setResult(null)
    const params: Record<string, unknown> = {}
    for (const [name, prop] of Object.entries(properties)) {
      const raw = (fieldValues[name] ?? '').trim()
      const kind = prop['type']
      if (raw === '') {
        if (prop['default'] !== undefined) params[name] = prop['default']
        continue
      }
      if (kind === 'array' || kind === 'object') {
        try { params[name] = JSON.parse(raw) } catch { setError(`"${name}" must be valid JSON`); setBusy(false); return }
      } else {
        params[name] = kind === 'number' || kind === 'integer' ? Number(raw) : kind === 'boolean' ? raw === 'true' : raw
      }
    }
    const res = await fetch(`/api/executor/${encodeURIComponent(executor.id)}/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, params, credentials: slotCreds }),
    })
    setBusy(false)
    setArmed(false)
    if (!res.ok) setError(await res.text())
    else {
      setResult(await res.json() as ExecutionRecord)
      void loadRecords()
    }
  }

  const missingCreds = executor.credentialSlots.some(s => !slotCreds[s.label])

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{executor.id}</h2>
            {executor.credentialSlots.length > 0 && (
              <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>write-capable</span>
            )}
          </div>
          {executor.description && <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>{executor.description}</p>}
        </div>
        <div className="flex gap-1.5 shrink-0">
          <button
            onClick={() => { if (records === null) void loadRecords(); else setRecords(null) }}
            className="text-xs px-2 py-1 rounded"
            style={{ background: records !== null ? 'var(--accent)' : 'var(--surface)', color: records !== null ? '#fff' : 'var(--muted)', border: '1px solid var(--border)' }}
          >
            records
          </button>
          <button
            onClick={() => setShowLogs(v => !v)}
            className="text-xs px-2 py-1 rounded"
            style={{ background: showLogs ? 'var(--accent)' : 'var(--surface)', color: showLogs ? '#fff' : 'var(--muted)', border: '1px solid var(--border)' }}
          >
            logs
          </button>
        </div>
      </div>

      {showLogs && <LogsPanel id={executor.id} logsUrl={`/api/executor/${encodeURIComponent(executor.id)}/logs?n=200`} sseType="executor_log" />}

      {records !== null && (
        <div className="rounded-md overflow-hidden max-h-72 overflow-y-auto font-mono text-xs" style={{ border: '1px solid var(--border)' }}>
          {records.length === 0 ? (
            <p className="p-3" style={{ color: 'var(--muted)' }}>No execution records.</p>
          ) : records.map((r, i) => (
            <div key={`${r.executedAt}-${i}`} className="px-3 py-1.5 flex gap-2 items-center" style={{ borderTop: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <span className="shrink-0 opacity-60" style={{ color: 'var(--muted)' }}>{new Date(r.executedAt).toLocaleString()}</span>
              <span className="shrink-0" style={{ color: r.status === 'success' ? '#4ade80' : r.status === 'failed' ? 'var(--danger)' : 'var(--warning)' }}>{r.status}</span>
              <span className="shrink-0" style={{ color: 'var(--accent)' }}>{r.instruction?.action}</span>
              <button
                onClick={() => setRecordModal(r)}
                className="flex-1 min-w-0 text-left truncate"
                title="Open full record"
                style={{ color: 'var(--muted)', background: 'transparent' }}
              >
                {JSON.stringify(r.instruction?.params)}{r.error ? ` — ${r.error}` : ''}{r.data ? ` → ${JSON.stringify(r.data)}` : ''}
              </button>
              <CopyButton value={r} />
            </div>
          ))}
        </div>
      )}
      {recordModal && (
        <JsonModal
          title={`${recordModal.instruction?.action} · ${new Date(recordModal.executedAt).toLocaleString()}`}
          data={recordModal}
          onClose={() => setRecordModal(null)}
        />
      )}

      {/* Manual fire console */}
      <section className="rounded-lg p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>MANUAL FIRE</span>

        <div className="flex flex-col gap-1">
          <label className="text-xs" style={{ color: 'var(--muted)' }}>Action</label>
          <select
            value={action}
            onChange={(e) => { setAction(e.target.value); setFieldValues({}) }}
            className="rounded-md px-2 py-1.5 text-xs font-mono self-start"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            {executor.supportedActions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>

        {/* Params — one row per field, with its full description */}
        <div className="flex flex-col gap-2">
          {Object.entries(properties).map(([name, prop]) => {
            const kind = prop['type']
            const isJson = kind === 'array' || kind === 'object'
            return (
              <div key={name} className="flex flex-col gap-0.5">
                <label className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
                  {(prop['displayName'] as string) ?? name}
                  {required.has(name) && !('default' in prop) && <span style={{ color: 'var(--danger)' }}> *</span>}
                  {'default' in prop && <span className="ml-1" style={{ color: 'var(--muted)' }}>(default: {JSON.stringify(prop['default'])})</span>}
                </label>
                {(prop['description'] as string) && (
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>{prop['description'] as string}</span>
                )}
                {Array.isArray(prop['enum']) ? (
                  <select
                    value={fieldValues[name] ?? String(prop['default'] ?? '')}
                    onChange={(e) => setFieldValues(v => ({ ...v, [name]: e.target.value }))}
                    className="rounded-md px-2 py-1.5 text-xs font-mono self-start"
                    style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                  >
                    <option value="">—</option>
                    {(prop['enum'] as unknown[]).map(v => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                  </select>
                ) : isJson ? (
                  <textarea
                    value={fieldValues[name] ?? ''}
                    onChange={(e) => setFieldValues(v => ({ ...v, [name]: e.target.value }))}
                    rows={3}
                    spellCheck={false}
                    placeholder={kind === 'array' ? '[ … ] (JSON)' : '{ … } (JSON)'}
                    className="rounded-md px-2 py-1.5 text-xs font-mono resize-y"
                    style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                  />
                ) : (
                  <input
                    value={fieldValues[name] ?? ''}
                    onChange={(e) => setFieldValues(v => ({ ...v, [name]: e.target.value }))}
                    placeholder={prop['default'] !== undefined ? String(prop['default']) : String(kind ?? '')}
                    className="rounded-md px-2 py-1.5 text-xs font-mono w-72"
                    style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                  />
                )}
              </div>
            )
          })}
        </div>

        {/* Credential slots */}
        {executor.credentialSlots.map((slot) => {
          const eligible = eligibleCredentials(slot, credentials, credentialTypes)
          return (
            <div key={slot.label} className="flex flex-col gap-0.5">
              <label className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
                Credential slot: {slot.label} <span style={{ color: 'var(--muted)' }}>{slot.raw ? `raw ${slot.type}` : slot.kind}</span>
              </label>
              <select
                value={slotCreds[slot.label] ?? ''}
                onChange={(e) => setSlotCreds(v => ({ ...v, [slot.label]: e.target.value }))}
                className="rounded-md px-2 py-1.5 text-xs self-start"
                style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              >
                <option value="">{eligible.length === 0 ? 'no eligible credential' : 'choose credential…'}</option>
                {eligible.map(c => <option key={c.id} value={c.name}>{c.name} ({c.type})</option>)}
              </select>
            </div>
          )
        })}

        {executor.credentialSlots.length > 0 && (
          <label className="flex items-start gap-2 text-xs px-3 py-2 rounded-md cursor-pointer" style={{ background: '#3a2e1a', color: 'var(--warning)' }}>
            <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} className="mt-0.5" />
            I understand this fires a REAL instruction with the selected credential — orders placed here are live
            (use a testnet credential to rehearse).
          </label>
        )}

        <button
          onClick={() => void fire()}
          disabled={busy || (executor.credentialSlots.length > 0 && (!armed || missingCreds))}
          className="self-start px-4 py-2 rounded-md text-sm"
          style={{
            background: 'var(--danger)',
            color: '#fff',
            opacity: busy || (executor.credentialSlots.length > 0 && (!armed || missingCreds)) ? 0.4 : 1,
          }}
        >
          {busy ? 'Firing…' : 'Fire'}
        </button>

        {error && <p className="text-xs px-3 py-2 rounded-md whitespace-pre-wrap" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</p>}
        {result && (
          <div className="text-xs px-3 py-2 rounded-md font-mono" style={{ background: result.status === 'success' ? '#1a3a24' : '#3f1f1f', color: result.status === 'success' ? '#4ade80' : 'var(--danger)' }}>
            {result.status}{result.error ? ` — ${result.error}` : ''}{result.data ? ` → ${JSON.stringify(result.data)}` : ''}
          </div>
        )}
      </section>
    </div>
  )
}
