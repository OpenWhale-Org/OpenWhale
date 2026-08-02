'use client'

import { useState } from 'react'
import type { MonitorInstanceView, CredentialInfo, ParamFieldDef } from '@openwhaleorg/core'

interface ImplementationInfo {
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

interface Props {
  initialInstances: MonitorInstanceView[]
  implementations: ImplementationInfo[]
  pendingKeys: Record<string, string[]>
  credentials: CredentialInfo[]
}

const inputStyle = {
  background: 'var(--background)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
} as const

/**
 * Monitor instances — the runners behind each contract. One key is only ever
 * produced by one active instance; unserved subscribed keys are listed as
 * "missing instance" hints. Credential-less implementations get a default
 * instance automatically, so this section is mostly about credentialed ones.
 */
export function MonitorInstancesSection({ initialInstances, implementations, pendingKeys, credentials }: Props) {
  const [instances, setInstances] = useState(initialInstances)
  const [pending, setPending] = useState(pendingKeys)
  const [implId, setImplId] = useState(implementations[0]?.id ?? '')
  const [credential, setCredential] = useState('')
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  /** Instance id currently in param-edit mode (inactive only), with its field values. */
  const [editing, setEditing] = useState<{ id: string; values: Record<string, string> } | null>(null)
  const [error, setError] = useState('')

  const impl = implementations.find(i => i.id === implId)
  const eligibleCredentials = impl?.credential
    ? credentials.filter(c => c.type === impl.credential!.type)
    : []

  async function refresh() {
    const res = await fetch('/api/monitor-instances')
    if (res.ok) {
      const data = await res.json() as { instances: MonitorInstanceView[]; pendingKeys: Record<string, string[]> }
      setInstances(data.instances)
      setPending(data.pendingKeys)
    }
  }

  async function post(url: string, body: unknown): Promise<void> {
    setError('')
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? 'request failed')
    await refresh()
  }

  async function remove(id: string) {
    setError('')
    const res = await fetch(`/api/monitor-instances/${id}`, { method: 'DELETE' })
    if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? 'delete failed')
    await refresh()
  }

  return (
    <div className="flex flex-col gap-4 mt-8">
      <h2 className="text-lg font-semibold">Monitor Instances</h2>

      {error && (
        <div className="px-4 py-2 rounded-md text-sm" style={{ background: 'color-mix(in srgb, var(--danger, #ef4444) 12%, transparent)', color: 'var(--danger, #ef4444)' }}>
          {error}
        </div>
      )}

      {Object.keys(pending).length > 0 && (
        <div className="px-4 py-2 rounded-md text-sm" style={{ background: 'color-mix(in srgb, var(--warning, #eab308) 12%, transparent)', color: 'var(--warning, #eab308)' }}>
          Unserved keys (subscribed, but no active instance covers them):{' '}
          {Object.entries(pending).map(([contract, keys]) => `${contract} → [${keys.join(', ')}]`).join(' · ')}
        </div>
      )}

      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--border)' }}>
        <table className="w-full text-sm">
          <thead>
            <tr style={{ background: 'var(--surface)', color: 'var(--muted)' }}>
              <th className="text-left px-4 py-2 font-medium">Implementation</th>
              <th className="text-left px-4 py-2 font-medium">Contract</th>
              <th className="text-left px-4 py-2 font-medium">Credential</th>
              <th className="text-left px-4 py-2 font-medium">Serving Keys</th>
              <th className="text-left px-4 py-2 font-medium">Active</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {instances.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center" style={{ color: 'var(--muted)' }}>No monitor instances.</td></tr>
            )}
            {instances.map((inst) => (
              <>
                <tr key={inst.id} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="px-4 py-2 font-mono text-xs" title={inst.id}>
                    {inst.implementationDisplayName ?? inst.implementation}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--muted)' }}>{inst.contract}</td>
                  <td className="px-4 py-2 text-xs">{inst.credential ?? '—'}</td>
                  <td className="px-4 py-2 font-mono text-xs" style={{ color: 'var(--muted)' }}>
                    {inst.servingKeys?.length ? inst.servingKeys.join(', ') : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <span className="px-2 py-0.5 rounded-full text-xs" style={{
                      background: inst.active ? 'color-mix(in srgb, var(--success, #22c55e) 15%, transparent)' : 'color-mix(in srgb, var(--muted) 15%, transparent)',
                      color: inst.active ? 'var(--success, #22c55e)' : 'var(--muted)',
                    }}>
                      {inst.active ? 'active' : 'inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {!inst.active && (inst.paramsFields?.length ?? 0) > 0 && (
                      <button
                        onClick={() => setEditing(editing?.id === inst.id ? null : {
                          id: inst.id,
                          values: Object.fromEntries(Object.entries(inst.params ?? {}).map(([k, v]) => [k, String(v)])),
                        })}
                        className="text-xs px-2 py-1 rounded-md mr-2"
                        style={{ border: '1px solid var(--border)' }}
                        title="Params are editable while inactive; they freeze on activation"
                      >
                        Params
                      </button>
                    )}
                    <button
                      onClick={() => post(`/api/monitor-instances/${inst.id}`, { action: inst.active ? 'deactivate' : 'activate' })}
                      className="text-xs px-2 py-1 rounded-md mr-2"
                      style={{ border: '1px solid var(--border)' }}
                    >
                      {inst.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button onClick={() => remove(inst.id)} className="text-xs px-2 py-1 rounded-md" style={{ color: 'var(--danger, #ef4444)', border: '1px solid var(--border)' }}>
                      Delete
                    </button>
                  </td>
                </tr>
                {editing?.id === inst.id && (
                  <tr key={`${inst.id}-params`} style={{ background: 'var(--surface)' }}>
                    <td colSpan={6} className="px-4 py-3">
                      <div className="flex flex-wrap items-end gap-3">
                        <ParamsFields
                          fields={inst.paramsFields ?? []}
                          values={editing.values}
                          onChange={(name, value) => setEditing((prev) => prev && { ...prev, values: { ...prev.values, [name]: value } })}
                        />
                        <button
                          onClick={async () => {
                            setError('')
                            const res = await fetch(`/api/monitor-instances/${inst.id}`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ params: buildParams(inst.paramsFields ?? [], editing.values) }),
                            })
                            if (!res.ok) setError(((await res.json()) as { error?: string }).error ?? 'update failed')
                            else setEditing(null)
                            await refresh()
                          }}
                          className="text-xs px-3 py-1.5 rounded-md"
                          style={{ background: 'var(--accent)', color: '#fff' }}
                        >
                          Save Params
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create — mostly for credentialed implementations (single-active per implementation) */}
      <form
        onSubmit={(e) => {
          e.preventDefault()
          const params = buildParams(impl?.paramsFields ?? [], paramValues)
          void post('/api/monitor-instances', {
            implementation: implId,
            ...(credential ? { credential } : {}),
            ...(Object.keys(params).length > 0 ? { params } : {}),
          }).then(() => setParamValues({}))
        }}
        className="flex flex-col gap-3 p-4 rounded-lg"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <select value={implId} onChange={(e) => { setImplId(e.target.value); setCredential(''); setParamValues({}) }} className="rounded-md px-3 py-2 text-sm" style={inputStyle}>
            {implementations.map(i => (
              <option key={i.id} value={i.id}>
                {i.displayName ?? i.id}{i.credential ? ` — needs ${i.credential.type} credential (${i.credential.level})` : ''}
              </option>
            ))}
          </select>
          {impl?.credential && (
            <select value={credential} onChange={(e) => setCredential(e.target.value)} required={impl.credential.level === 'required'} className="rounded-md px-3 py-2 text-sm" style={inputStyle}>
              <option value="">{impl.credential.level === 'required' ? `choose ${impl.credential.type} credential…` : 'no credential (optional)'}</option>
              {eligibleCredentials.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
          )}
          <button type="submit" className="px-4 py-2 rounded-md text-sm" style={{ background: 'var(--accent)', color: '#fff' }}>
            Create & Activate
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
      </form>
    </div>
  )
}
