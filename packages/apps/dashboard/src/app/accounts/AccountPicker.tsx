'use client'

import { useEffect, useMemo, useState } from 'react'
import type { AccountImplementationInfo, CredentialInfo, CredentialTypeInfo } from '@openwhaleorg/core'
import { Rail, RailGroup, RailItem } from '../../components/Rail'
import { ParamsFields, buildParams } from '../../components/ParamsFields'
import { Select } from '../../components/Select'
import { TypeMark, CredentialMark } from '../../components/TypeMark'
import { Modal, ModalMaximizeButton } from '../../components/Modal'

/**
 * New Account, the way New Strategy does it: browse implementations on the
 * left with their plugin as the heading, read what the pick needs on the
 * right, name it, bind a credential, fill its params, create. The inline form
 * this replaced hid the choice inside a native <select> whose option text had
 * to carry the kind, the venue and the name in one line.
 */

const inputStyle = {
  background: 'var(--background)',
  color: 'var(--foreground)',
  border: '1px solid var(--border)',
} as const

function matches(i: AccountImplementationInfo, q: string): boolean {
  if (!q) return true
  const hay = [i.displayName ?? '', i.id, i.kind, i.type ?? '', i.pluginName, ...(i.credentialTypes ?? [])].join(' ').toLowerCase()
  return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.includes(t))
}

/** Credentials that can open this implementation's cell(s). */
export function eligibleCredentialsFor(impl: AccountImplementationInfo | undefined, credentials: CredentialInfo[], credentialTypes: CredentialTypeInfo[]): CredentialInfo[] {
  if (!impl) return []
  return credentials.filter((c) => {
    if (impl.type !== undefined) return (impl.credentialTypes ?? [impl.type]).includes(c.type)
    const typeInfo = credentialTypes.find(t => t.type === c.type)
    return typeInfo?.kinds.includes(impl.kind) ?? false
  })
}

export function AccountPicker({ implementations, credentials, credentialTypes, onCreated, onClose }: {
  implementations: AccountImplementationInfo[]
  credentials: CredentialInfo[]
  credentialTypes: CredentialTypeInfo[]
  onCreated: (name: string) => Promise<void> | void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [implId, setImplId] = useState(implementations[0]?.id ?? '')
  const [name, setName] = useState('')
  const [credential, setCredential] = useState('')
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const groups = useMemo(() => {
    const hits = implementations.filter(i => matches(i, query))
    const by = new Map<string, AccountImplementationInfo[]>()
    for (const i of hits) (by.get(i.pluginName) ?? by.set(i.pluginName, []).get(i.pluginName)!).push(i)
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([plugin, items]) => ({ plugin, items: items.sort((x, y) => (x.displayName ?? x.id).localeCompare(y.displayName ?? y.id)) }))
  }, [implementations, query])
  const flat = useMemo(() => groups.flatMap(g => g.items), [groups])
  const impl = implementations.find(i => i.id === implId)

  useEffect(() => {
    if (flat.length === 0) return
    if (!flat.some(i => i.id === implId)) setImplId(flat[0]!.id)
  }, [flat, implId])

  const eligible = eligibleCredentialsFor(impl, credentials, credentialTypes)
  const acceptedTypes = impl ? (impl.type !== undefined ? (impl.credentialTypes ?? [impl.type]) : credentialTypes.filter(t => t.kinds.includes(impl.kind)).map(t => t.type)) : []
  // The implementation's own mark (the venue's brand) first; a credential
  // type's mark when it has none; a letter chip last.
  const markFor = (i: AccountImplementationInfo) => {
    const type = i.type ?? i.credentialTypes?.[0]
    const t = type ? credentialTypes.find(x => x.type === type) : undefined
    return <TypeMark logo={i.logo ?? t?.logo} icon={i.icon ?? t?.icon} label={i.displayName ?? i.id} size={22} />
  }

  function pickImpl(id: string) {
    if (id === implId) return
    setImplId(id); setCredential(''); setParamValues({}); setError('')
  }

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (!impl) return
    setError('')
    setBusy(true)
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          implementation: impl.id,
          ...(credential ? { credential } : {}),
          ...(impl.paramsFields?.length ? { params: buildParams(impl.paramsFields, paramValues) } : {}),
        }),
      })
      if (!res.ok) { setError(((await res.json()) as { error?: string }).error ?? 'failed'); return }
      await onCreated(name)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={onClose} maxWidth="64rem" height="min(80vh, 44rem)" maximizable persistKey="ow.modal.account-picker">
      <div className="flex items-center justify-between px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <div>
          <div className="text-sm font-medium">New account</div>
          <div className="text-xs" style={{ color: 'var(--muted)' }}>
            implementation × credential → a live venue account · {implementations.length} implementations
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">Cancel</button>
          <ModalMaximizeButton />
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        {/* ── Left: implementations by plugin ── */}
        <Rail bare width="17rem" search={{ value: query, onChange: setQuery, placeholder: 'Search implementations…', autoFocus: true }}>
          {groups.length === 0 && (
            <div className="text-xs px-3 py-4" style={{ color: 'var(--muted)' }}>Nothing matches “{query}”.</div>
          )}
          {groups.map(g => (
            <RailGroup key={g.plugin} label={g.plugin} count={g.items.length}>
              {g.items.map(i => (
                <RailItem
                  key={i.id}
                  active={i.id === implId}
                  onClick={() => pickImpl(i.id)}
                  mark={markFor(i)}
                  title={i.displayName ?? i.id}
                  subtitle={<span className="mono">{i.kind}{i.type ? ` · ${i.type}` : ' · any venue'}</span>}
                />
              ))}
            </RailGroup>
          ))}
        </Rail>

        {/* ── Right: what it is, name it, bind it ── */}
        <form onSubmit={create} className="flex-1 min-w-0 flex flex-col" data-tour="account-form">
          {!impl ? (
            <div className="flex-1 grid place-items-center text-sm" style={{ color: 'var(--muted)' }}>No implementation selected</div>
          ) : (
            <>
              <div className="flex-1 overflow-y-auto scroll-hidden p-5 flex flex-col gap-5">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-semibold">{impl.displayName ?? impl.id}</h3>
                    <span className="badge badge-neutral mono">{impl.kind}</span>
                    <span className="badge badge-neutral">{impl.type ?? 'any venue'}</span>
                  </div>
                  <div className="text-xs mono mt-1" style={{ color: 'var(--muted)' }}>{impl.id}</div>
                  <div className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                    Opened by {acceptedTypes.length ? acceptedTypes.map(t => <span key={t} className="badge badge-neutral mono mr-1">{t}</span>) : 'no known credential type'}
                  </div>
                </div>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Name</span>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    autoFocus
                    placeholder={`e.g. ${(impl.type ?? impl.kind.split('/')[0] ?? 'main').replace(/[^a-z0-9]/gi, '-')}-main`}
                    className="rounded-md px-3 h-9 text-sm"
                    style={inputStyle}
                  />
                </label>

                <div className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Credential</span>
                  <Select
                    value={credential}
                    onChange={setCredential}
                    options={[
                      { value: '', label: 'Bind later', hint: 'The account exists but stays inactive until a credential is bound' },
                      ...eligible.map(c => ({
                        value: c.name, label: c.name, hint: c.type,
                        mark: <CredentialMark credential={c.name} credentials={credentials} credentialTypes={credentialTypes} size={22} />,
                      })),
                    ]}
                  />
                  {eligible.length === 0 && (
                    <p className="text-xs" style={{ color: 'var(--warning, #eab308)' }}>
                      No eligible credential for {impl.type ?? impl.kind} — add one on the Credentials page, or create the account unbound.
                    </p>
                  )}
                </div>

                {(impl.paramsFields?.length ?? 0) > 0 && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Parameters</span>
                    <div className="card-inset p-3">
                      <ParamsFields
                        fields={impl.paramsFields!}
                        values={paramValues}
                        onChange={(n, v) => setParamValues(prev => ({ ...prev, [n]: v }))}
                      />
                    </div>
                  </div>
                )}

                {error && (
                  <div className="px-3 py-2 rounded-md text-sm" style={{ background: 'color-mix(in srgb, var(--danger) 12%, transparent)', color: 'var(--danger)' }}>
                    {error}
                  </div>
                )}
              </div>

              <div className="flex justify-end gap-2 px-5 py-3 shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
                <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
                <button type="submit" disabled={busy || !name.trim()} className="btn btn-primary" style={{ opacity: busy ? 0.6 : 1 }}>
                  {busy ? 'Creating…' : 'Create account'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </Modal>
  )
}
