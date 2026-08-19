'use client'

import { useState } from 'react'
import type { MonitorInstanceView, CredentialInfo, ParamFieldDef } from '@openwhaleorg/core'
import { Modal } from '@/components/Modal'

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
export function MonitorInstancesPanel({ contract, instances, implementations, pendingKeys, credentials, onChanged, embedded = false }: Props & { embedded?: boolean }) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
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
    /*
     * Activate on creation ONLY when this would be the contract's first
     * instance. Each implementation is its own dispatch domain with one active
     * instance, so auto-activating the second one silently takes over from the
     * first — a creation form is not where you decide to cut a running
     * collector over. With nothing running yet there is no such ambiguity, and
     * making the operator press Start on the only possible answer is friction.
     */
    const solo = mine.length === 0
    const ok = await post('/api/monitor-instances', {
      implementation: impl.id,
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(credential ? { credential } : {}),
      ...(Object.keys(params).length > 0 ? { params } : {}),
      activate: solo,
    })
    if (ok) { setParamValues({}); setCredential(''); setName(''); setCreating(false); await onChanged() }
  }

  return (
    <section className="rounded-lg p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>INSTANCES ({mine.length})</span>
        {multiDomain && (
          <span className="text-xs" style={{ color: 'var(--muted)' }} title="Each implementation is its own dispatch domain — one active instance each">
            {new Set(mine.map(i => i.implementation)).size} implementations · one active each
          </span>
        )}
        {impls.length > 0 && (
          <button
            onClick={() => { setCreating(true); setImplId(impls[0]!.id) }}
            className="hoverable hoverable-flat ml-auto text-xs px-2.5 h-8 rounded-md"
            style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
          >
            ＋ New instance
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
              <div
                key={inst.id}
                className="hoverable hoverable-flat flex flex-col rounded-md px-3 py-2 mt-1.5"
                style={{ background: 'var(--background)', border: '1px solid var(--border)' }}
              >
                <div className="flex items-center gap-2 flex-wrap">
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
                    {/* The operator's label leads; the implementation it runs
                        becomes the subtitle. With no label the implementation
                        is the name, which is the common single-instance case. */}
                    <span className="text-sm truncate" title={inst.id}>
                      {inst.name ?? inst.implementationDisplayName ?? inst.implementation}
                    </span>
                    {inst.name && (
                      <span className="font-mono text-xs truncate" style={{ color: 'var(--muted)' }}>
                        {inst.implementationDisplayName ?? inst.implementation}
                      </span>
                    )}
                  </button>
                  {inst.credential && (
                    <span className="text-xs px-1.5 py-0.5 rounded font-mono" style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}>
                      {inst.credential}
                    </span>
                  )}
                  <span className="text-xs font-mono truncate" style={{ color: 'var(--muted)' }} title={summarizeParams(inst.params)}>
                    {summarizeParams(inst.params)}
                  </span>
                  {inst.servingKeys?.length ? (
                    <span className="text-xs font-mono truncate" style={{ color: 'var(--muted)' }} title={inst.servingKeys.join(', ')}>
                      serving {inst.servingKeys.length}
                    </span>
                  ) : null}
                  {inst.problem && (
                    <span className="text-xs" style={{ color: 'var(--danger)' }} title={inst.problem}>⚠ {inst.problem}</span>
                  )}
                  <div className="ml-auto flex items-center gap-1.5 shrink-0">
                    {editable && (
                      <button
                        onClick={() => setEditing(editing?.id === inst.id ? null : {
                          id: inst.id,
                          values: Object.fromEntries(Object.entries(inst.params ?? {}).map(([k, v]) => [k, String(v)])),
                        })}
                        className="text-xs px-2 py-1 rounded-md"
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
                        className="text-xs px-2 py-1 rounded-md"
                        style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                        title="Stop this instance — its keys go unserved until something else covers them"
                      >
                        Stop
                      </button>
                    )}
                    <button
                      onClick={() => void remove(inst.id)}
                      disabled={busy}
                      className="text-xs px-2 py-1 rounded-md"
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
        <Modal onClose={() => setCreating(false)} maxWidth="38rem" height="min(80vh, 40rem)">
          <div className="flex items-center gap-2 px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <h2 className="font-semibold text-base flex-1 min-w-0 truncate">New instance · {contract}</h2>
            <button type="button" onClick={() => setCreating(false)} className="w-7 h-7 rounded-md flex items-center justify-center" style={{ color: 'var(--muted)' }} aria-label="Close">✕</button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden px-5 py-4 flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: 'var(--muted)' }}>Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={impl?.displayName ?? impl?.id ?? ''}
                className="rounded-md px-3 h-9 text-sm"
                style={inputStyle}
              />
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                Optional — the implementation&apos;s own name is used when blank. Worth setting once a
                contract runs more than one.
              </span>
            </label>

            {impls.length > 1 && (
              <label className="flex flex-col gap-1">
                <span className="text-xs" style={{ color: 'var(--muted)' }}>Implementation</span>
                <select
                  value={impl?.id ?? ''}
                  onChange={(e) => { setImplId(e.target.value); setCredential(''); setParamValues({}) }}
                  className="rounded-md px-2 h-9 text-sm"
                  style={inputStyle}
                >
                  {impls.map(i => (
                    <option key={i.id} value={i.id}>
                      {i.displayName ?? i.id}{i.credential ? ` — needs ${i.credential.type} (${i.credential.level})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {impl?.credential && (
              <label className="flex flex-col gap-1">
                <span className="text-xs" style={{ color: 'var(--muted)' }}>
                  Credential {impl.credential.level === 'required' ? '(required)' : '(optional)'}
                </span>
                <select
                  value={credential}
                  onChange={(e) => setCredential(e.target.value)}
                  required={impl.credential.level === 'required'}
                  className="rounded-md px-2 h-9 text-sm"
                  style={inputStyle}
                >
                  <option value="">{impl.credential.level === 'required' ? `choose ${impl.credential.type} credential…` : 'no credential'}</option>
                  {eligibleCredentials.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
                </select>
              </label>
            )}

            {(impl?.paramsFields?.length ?? 0) > 0 && (
              <div className="flex flex-col gap-1">
                <span className="text-xs" style={{ color: 'var(--muted)' }}>Parameters</span>
                <ParamsFields
                  fields={impl!.paramsFields!}
                  values={paramValues}
                  onChange={(name, value) => setParamValues((prev) => ({ ...prev, [name]: value }))}
                />
              </div>
            )}

            {impl?.credential?.level === 'required' && eligibleCredentials.length === 0 && (
              <span className="text-xs" style={{ color: 'var(--warning, #eab308)' }}>
                No {impl.credential.type} credential stored — add one on the Credentials page first.
              </span>
            )}
          </div>

          <div className="shrink-0 flex items-center gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--border)' }}>
            <span className="text-xs flex-1 min-w-0" style={{ color: 'var(--muted)' }}>
              {mine.length === 0
                ? 'Starts collecting straight away — nothing else serves this contract yet.'
                : `Created stopped. ${mine.length} instance${mine.length > 1 ? 's' : ''} already here, and one implementation serves at a time.`}
            </span>
            <button
              onClick={() => void create()}
              disabled={busy || (impl?.credential?.level === 'required' && !credential)}
              className="px-4 h-9 rounded-md text-sm shrink-0"
              style={{ background: 'var(--accent)', color: '#fff', opacity: busy ? 0.5 : 1 }}
            >
              {busy ? 'Creating…' : mine.length === 0 ? 'Create & start' : 'Create'}
            </button>
          </div>
        </Modal>
      )}

    </section>
  )
}
