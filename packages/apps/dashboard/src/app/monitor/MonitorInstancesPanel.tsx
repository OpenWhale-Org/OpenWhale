'use client'

import { useState } from 'react'
import type { MonitorInstanceView, CredentialInfo, ParamFieldDef } from '@openwhaleorg/core'

export interface ImplementationInfo {
  id: string
  contract: string
  owner: string
  displayName?: string
  description?: string
  credential?: { type: string; level: 'optional' | 'required' }
  paramsFields?: ParamFieldDef[]
}

/** Schema-derived tuning fields (numbers/booleans/strings). Values as strings; empty = use default. */
function ParamsFields({ fields, values, onChange }: {
  fields: ParamFieldDef[]
  values: Record<string, string>
  onChange: (name: string, value: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {fields.map((f) => (
        <label key={f.name} className="flex flex-col gap-0.5 text-xs" style={{ color: 'var(--muted)' }} title={f.description}>
          {f.displayName}
          {f.type === 'boolean' ? (
            <select
              value={values[f.name] ?? ''}
              onChange={(e) => onChange(f.name, e.target.value)}
              className="rounded-md px-2 py-1.5"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              <option value="">default{f.default !== undefined ? ` (${String(f.default)})` : ''}</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              value={values[f.name] ?? ''}
              onChange={(e) => onChange(f.name, e.target.value)}
              placeholder={f.default !== undefined ? String(f.default) : ''}
              className="rounded-md px-2 py-1.5 w-36"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            />
          )}
        </label>
      ))}
    </div>
  )
}

/** String field values → typed params object; empty fields omitted so schema defaults apply. */
function buildParams(fields: ParamFieldDef[], values: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const raw = (values[f.name] ?? '').trim()
    if (raw === '') continue
    out[f.name] = f.type === 'number' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : raw
  }
  return out
}

/** One-line params summary for a collapsed row; '—' when the instance runs on defaults. */
function summarizeParams(params?: Record<string, unknown>): string {
  const entries = Object.entries(params ?? {})
  if (entries.length === 0) return '—'
  return entries.map(([k, v]) => `${k}=${String(v)}`).join(' ')
}

const inputStyle = {
  background: 'var(--background)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
} as const

interface Props {
  /** Qualified contract id — the monitor selected on the left. */
  contract: string
  instances: MonitorInstanceView[]
  implementations: ImplementationInfo[]
  pendingKeys: Record<string, string[]>
  credentials: CredentialInfo[]
  /** Refetch instances AND monitor status: activating one changes both. */
  onChanged: () => void | Promise<void>
}

/**
 * Instances of ONE monitor contract — the runners behind it, configured right
 * where the monitor is selected rather than in a separate table at the bottom
 * of the page (which made "which instance serves this monitor" a lookup).
 *
 * Activation is a RADIO within an implementation, because that is what the
 * runtime enforces: single-active per implementation (the dispatch domain).
 * Picking a second one deactivates its sibling first instead of surfacing the
 * runtime's "already has an active instance" error. A contract served by
 * several implementations (per-venue specializations) keeps one active each —
 * they cover different key spaces, so collapsing them into one radio would
 * silently stop collecting for a venue.
 */
export function MonitorInstancesPanel({ contract, instances, implementations, pendingKeys, credentials, onChanged }: Props) {
  const [creating, setCreating] = useState(false)
  const [implId, setImplId] = useState('')
  const [credential, setCredential] = useState('')
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  /** Instance id currently in param-edit mode (inactive only), with its field values. */
  const [editing, setEditing] = useState<{ id: string; values: Record<string, string> } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const mine = instances.filter(i => i.contract === contract)
  const impls = implementations.filter(i => i.contract === contract)
  const pending = pendingKeys[contract] ?? []
  const impl = impls.find(i => i.id === implId) ?? impls[0]
  const eligibleCredentials = impl?.credential ? credentials.filter(c => c.type === impl.credential!.type) : []
  /** Several implementations = several dispatch domains, each with its own active slot. */
  const multiDomain = new Set(mine.map(i => i.implementation)).size > 1

  async function send(url: string, init: RequestInit): Promise<boolean> {
    setBusy(true)
    setError('')
    const res = await fetch(url, init)
    setBusy(false)
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      setError(body.error ?? 'request failed')
      return false
    }
    return true
  }

  const post = (url: string, body: unknown) => send(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })

  /**
   * Radio semantics: picking one swaps out the sibling of the SAME
   * implementation. Clicking the ALREADY-active one does nothing — a radio
   * that turns itself off on a second click means one stray click stops a
   * live collector. Stopping is the explicit button next to it.
   */
  async function choose(inst: MonitorInstanceView) {
    if (inst.active) return
    const sibling = mine.find(i => i.active && i.implementation === inst.implementation && i.id !== inst.id)
    if (sibling && !await post(`/api/monitor-instances/${sibling.id}`, { action: 'deactivate' })) return
    if (await post(`/api/monitor-instances/${inst.id}`, { action: 'activate' })) await onChanged()
  }

  async function stop(inst: MonitorInstanceView) {
    if (await post(`/api/monitor-instances/${inst.id}`, { action: 'deactivate' })) await onChanged()
  }

  async function remove(id: string) {
    if (await send(`/api/monitor-instances/${id}`, { method: 'DELETE' })) await onChanged()
  }

  async function saveParams(inst: MonitorInstanceView) {
    if (!editing) return
    const ok = await send(`/api/monitor-instances/${inst.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: buildParams(inst.paramsFields ?? [], editing.values) }),
    })
    if (ok) { setEditing(null); await onChanged() }
  }

  async function create() {
    if (!impl) return
    const params = buildParams(impl.paramsFields ?? [], paramValues)
    const ok = await post('/api/monitor-instances', {
      implementation: impl.id,
      ...(credential ? { credential } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
    })
    if (ok) { setParamValues({}); setCredential(''); setCreating(false); await onChanged() }
  }

  return (
    <section className="rounded-lg p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>INSTANCES ({mine.length})</span>
        {multiDomain && (
          <span className="text-[10px]" style={{ color: 'var(--muted)' }} title="Each implementation is its own dispatch domain — one active instance each">
            {new Set(mine.map(i => i.implementation)).size} implementations · one active each
          </span>
        )}
        {impls.length > 0 && (
          <button
            onClick={() => { setCreating(v => !v); setImplId(impls[0]!.id) }}
            className="ml-auto text-xs px-2 py-1 rounded-md"
            style={{ border: '1px solid var(--border)', color: creating ? 'var(--accent)' : 'var(--muted)' }}
          >
            {creating ? 'Cancel' : '+ New'}
          </button>
        )}
      </div>

      {error && (
        <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</p>
      )}

      {pending.length > 0 && (
        <p className="text-xs px-3 py-2 rounded-md" style={{ background: 'color-mix(in srgb, var(--warning, #eab308) 12%, transparent)', color: 'var(--warning, #eab308)' }}>
          Subscribed but unserved — no active instance covers: {pending.join(', ')}
        </p>
      )}

      {mine.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {impls.length === 0
            ? 'No implementation registers for this contract.'
            : 'No instance yet — create one to start serving this monitor.'}
        </p>
      ) : (
        <div className="flex flex-col">
          {mine.map((inst) => {
            // Params are editable while running too — saving rebuilds the runner
            const editable = (inst.paramsFields?.length ?? 0) > 0
            return (
              <div key={inst.id} className="flex flex-col" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="flex items-center gap-2 py-2 flex-wrap">
                  {/* Radio, not a toggle: the runtime allows one active per implementation */}
                  <button
                    onClick={() => void choose(inst)}
                    disabled={busy || inst.active}
                    className="flex items-center gap-2 text-xs min-w-0"
                    title={inst.active ? 'Running' : 'Activate — stops the current one first'}
                    style={{ color: inst.active ? 'var(--foreground)' : 'var(--muted)', cursor: inst.active ? 'default' : 'pointer' }}
                  >
                    <span style={{ color: inst.active ? 'var(--success, #22c55e)' : 'var(--muted)' }}>
                      {inst.active ? '◉' : '○'}
                    </span>
                    <span className="font-mono truncate" title={inst.id}>
                      {inst.implementationDisplayName ?? inst.implementation}
                    </span>
                  </button>
                  {inst.credential && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
                      {inst.credential}
                    </span>
                  )}
                  <span className="text-[10px] font-mono truncate" style={{ color: 'var(--muted)' }} title={summarizeParams(inst.params)}>
                    {summarizeParams(inst.params)}
                  </span>
                  {inst.servingKeys?.length ? (
                    <span className="text-[10px] font-mono truncate" style={{ color: 'var(--muted)' }} title={inst.servingKeys.join(', ')}>
                      serving {inst.servingKeys.length}
                    </span>
                  ) : null}
                  {inst.problem && (
                    <span className="text-[10px]" style={{ color: 'var(--danger)' }} title={inst.problem}>⚠ {inst.problem}</span>
                  )}
                  <div className="ml-auto flex items-center gap-1.5 shrink-0">
                    {editable && (
                      <button
                        onClick={() => setEditing(editing?.id === inst.id ? null : {
                          id: inst.id,
                          values: Object.fromEntries(Object.entries(inst.params ?? {}).map(([k, v]) => [k, String(v)])),
                        })}
                        className="text-[10px] px-2 py-1 rounded-md"
                        style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                        title={inst.active
                          ? 'Edit params — saving rebuilds the runner (its keys come back, its in-memory state does not)'
                          : 'Edit params'}
                      >
                        Params
                      </button>
                    )}
                    {inst.active && (
                      <button
                        onClick={() => void stop(inst)}
                        disabled={busy}
                        className="text-[10px] px-2 py-1 rounded-md"
                        style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                        title="Stop this instance — its keys go unserved until something else covers them"
                      >
                        Stop
                      </button>
                    )}
                    <button
                      onClick={() => void remove(inst.id)}
                      disabled={busy}
                      className="text-[10px] px-2 py-1 rounded-md"
                      style={{ border: '1px solid var(--border)', color: 'var(--danger, #ef4444)' }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {editing?.id === inst.id && (
                  <div className="flex flex-wrap items-end gap-3 pb-3">
                    <ParamsFields
                      fields={inst.paramsFields ?? []}
                      values={editing.values}
                      onChange={(name, value) => setEditing((prev) => prev && { ...prev, values: { ...prev.values, [name]: value } })}
                    />
                    <button
                      onClick={() => void saveParams(inst)}
                      disabled={busy}
                      className="text-xs px-3 py-1.5 rounded-md"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                      title={inst.active ? 'Saves, then rebuilds the running instance from the new params' : undefined}
                    >
                      {inst.active ? 'Save & Restart' : 'Save Params'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {creating && impls.length > 0 && (
        <div className="flex flex-col gap-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex flex-wrap items-center gap-2">
            {impls.length > 1 && (
              <select
                value={impl?.id ?? ''}
                onChange={(e) => { setImplId(e.target.value); setCredential(''); setParamValues({}) }}
                className="rounded-md px-2 py-1.5 text-xs"
                style={inputStyle}
              >
                {impls.map(i => (
                  <option key={i.id} value={i.id}>
                    {i.displayName ?? i.id}{i.credential ? ` — needs ${i.credential.type} (${i.credential.level})` : ''}
                  </option>
                ))}
              </select>
            )}
            {impl?.credential && (
              <select
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                required={impl.credential.level === 'required'}
                className="rounded-md px-2 py-1.5 text-xs"
                style={inputStyle}
              >
                <option value="">{impl.credential.level === 'required' ? `choose ${impl.credential.type} credential…` : 'no credential (optional)'}</option>
                {eligibleCredentials.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
            )}
            <button
              onClick={() => void create()}
              disabled={busy || (impl?.credential?.level === 'required' && !credential)}
              className="px-3 py-1.5 rounded-md text-xs"
              style={{ background: 'var(--accent)', color: '#fff', opacity: busy ? 0.5 : 1 }}
            >
              Create &amp; Activate
            </button>
          </div>
          {(impl?.paramsFields?.length ?? 0) > 0 && (
            <ParamsFields
              fields={impl!.paramsFields!}
              values={paramValues}
              onChange={(name, value) => setParamValues((prev) => ({ ...prev, [name]: value }))}
            />
          )}
          {impl?.credential?.level === 'required' && eligibleCredentials.length === 0 && (
            <span className="text-xs" style={{ color: 'var(--warning, #eab308)' }}>
              No {impl.credential.type} credential stored — add one on the Credentials page first.
            </span>
          )}
        </div>
      )}
    </section>
  )
}
