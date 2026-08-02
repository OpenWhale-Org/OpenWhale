'use client'

import { useState } from 'react'
import type { CredentialInfo, CredentialTypeInfo } from '@openwhaleorg/core'

interface Props {
  initialCredentials: CredentialInfo[]
  credentialTypes: CredentialTypeInfo[]
}

// ── JSON Schema → form fields ─────────────────────────────────────────────────
//
// Credential types register a Zod schema; the server exports it as JSON Schema
// with `.meta()` extras (displayName, password, placeholder) merged into each
// property. This is the whole n8n-style trick: venues describe their fields,
// the dashboard renders them — no per-venue form components.

interface FieldSpec {
  name: string
  type: 'string' | 'number' | 'boolean'
  required: boolean
  displayName: string
  description?: string
  placeholder?: string
  password?: boolean
  pattern?: string
  defaultValue?: unknown
}

function fieldsFromJsonSchema(jsonSchema: Record<string, unknown>): FieldSpec[] {
  const properties = (jsonSchema['properties'] ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((jsonSchema['required'] ?? []) as string[])

  return Object.entries(properties).map(([name, prop]) => {
    const type = prop['type'] === 'boolean' ? 'boolean' : prop['type'] === 'number' || prop['type'] === 'integer' ? 'number' : 'string'
    const hasDefault = prop['default'] !== undefined
    return {
      name,
      type,
      // A field with a schema default is never user-mandatory
      required: required.has(name) && !hasDefault,
      displayName: (prop['displayName'] as string) ?? name,
      description: prop['description'] as string | undefined,
      placeholder: prop['placeholder'] as string | undefined,
      password: prop['password'] as boolean | undefined,
      pattern: prop['pattern'] as string | undefined,
      defaultValue: prop['default'],
    }
  })
}

/** Flat string state → typed credential data. Empty optional fields are omitted. */
function buildData(fields: FieldSpec[], values: Record<string, string>): { data: Record<string, unknown>; error?: string } {
  const data: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.type === 'boolean') {
      data[field.name] = (values[field.name] ?? String(field.defaultValue ?? false)) === 'true'
      continue
    }
    const raw = (values[field.name] ?? '').trim()
    if (raw === '') {
      if (field.required) return { data, error: `${field.displayName} is required` }
      continue
    }
    if (field.pattern && !new RegExp(field.pattern).test(raw))
      return { data, error: `${field.displayName} does not match the expected format` }
    if (field.type === 'number') {
      const n = parseFloat(raw)
      if (isNaN(n)) return { data, error: `${field.displayName} must be a number` }
      data[field.name] = n
    } else {
      data[field.name] = raw
    }
  }
  return { data }
}

// ── Schema-driven form ────────────────────────────────────────────────────────

function SchemaCredentialForm({
  typeInfo,
  onSubmit,
  loading,
}: {
  typeInfo: CredentialTypeInfo
  onSubmit: (name: string, data: Record<string, unknown>) => Promise<void>
  loading: boolean
}) {
  const fields = typeInfo.jsonSchema ? fieldsFromJsonSchema(typeInfo.jsonSchema) : []
  const [name, setName] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [testState, setTestState] = useState<'idle' | 'running' | 'ok' | 'failed'>('idle')
  const [testMessage, setTestMessage] = useState('')

  function set(field: string, value: string) {
    setValues((v) => ({ ...v, [field]: value }))
    setTestState('idle')
  }

  function assemble(): Record<string, unknown> | null {
    const { data, error: buildError } = buildData(fields, values)
    if (buildError) { setError(buildError); return null }
    return data
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const data = assemble()
    if (data) await onSubmit(name, data)
  }

  async function testConnection() {
    setError('')
    const data = assemble()
    if (!data) return
    setTestState('running')
    setTestMessage('')
    try {
      const res = await fetch(`/api/credential-types/${encodeURIComponent(typeInfo.type)}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      })
      if (res.ok) {
        setTestState('ok')
      } else {
        setTestState('failed')
        setTestMessage(await res.text() || `HTTP ${res.status}`)
      }
    } catch (err) {
      setTestState('failed')
      setTestMessage(err instanceof Error ? err.message : 'Network error')
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      {(typeInfo.kinds.length > 0 || typeInfo.documentationUrl) && (
        <div className="flex items-center gap-2 flex-wrap text-xs" style={{ color: 'var(--muted)' }}>
          {typeInfo.kinds.map((k) => (
            <span key={k} className="px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
              {k}
            </span>
          ))}
          {typeInfo.documentationUrl && (
            <a href={typeInfo.documentationUrl} target="_blank" rel="noreferrer" className="underline" style={{ color: 'var(--accent)' }}>
              docs ↗
            </a>
          )}
        </div>
      )}

      <InputField label="Name" value={name} onChange={setName} placeholder={`e.g. ${typeInfo.displayName ?? typeInfo.type} Main`} required />

      {fields.map((field) =>
        field.type === 'boolean' ? (
          <label key={field.name} className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--foreground)' }}>
            <input
              type="checkbox"
              checked={(values[field.name] ?? String(field.defaultValue ?? false)) === 'true'}
              onChange={(e) => set(field.name, String(e.target.checked))}
              className="accent-blue-500"
            />
            {field.displayName}
            {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.description}</span>}
          </label>
        ) : (
          <InputField
            key={field.name}
            label={field.displayName}
            value={values[field.name] ?? ''}
            onChange={(v) => set(field.name, v)}
            placeholder={field.placeholder ?? (field.required ? undefined : field.description)}
            required={field.required}
            type={field.password ? 'password' : field.type === 'number' ? 'number' : 'text'}
            hint={field.description}
            mono
          />
        ),
      )}

      {error && <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</p>}
      {testState === 'ok' && (
        <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#1a3a24', color: 'var(--success, #4ade80)' }}>
          ✓ Connection test passed
        </p>
      )}
      {testState === 'failed' && (
        <p className="text-xs px-3 py-2 rounded-md whitespace-pre-wrap" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
          Connection test failed: {testMessage}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {typeInfo.hasTest && (
          <button
            type="button"
            onClick={() => void testConnection()}
            disabled={loading || testState === 'running'}
            className="px-4 py-2 rounded-md text-sm"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', opacity: testState === 'running' ? 0.6 : 1 }}
          >
            {testState === 'running' ? 'Testing…' : 'Test connection'}
          </button>
        )}
        <button
          type="submit"
          disabled={loading || !name}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  )
}

// ── Fallback form (unregistered types / schemaless) ───────────────────────────

function GenericCredentialForm({
  onSubmit,
  loading,
  fixedType,
}: {
  onSubmit: (name: string, data: Record<string, unknown>, customType: string) => Promise<void>
  loading: boolean
  /** When set, the type is known but has no schema — only the data is free-form. */
  fixedType?: string
}) {
  const [name, setName] = useState('')
  const [customType, setCustomType] = useState('')
  const [rawData, setRawData] = useState('{}')
  const [jsonError, setJsonError] = useState('')

  const type = fixedType ?? customType.trim()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    let data: Record<string, unknown>
    try {
      data = JSON.parse(rawData) as Record<string, unknown>
    } catch {
      setJsonError('Invalid JSON')
      return
    }
    await onSubmit(name, data, type)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <InputField label="Name" value={name} onChange={setName} placeholder="e.g. My Account" required />
      {!fixedType && (
        <InputField
          label="Type"
          value={customType}
          onChange={setCustomType}
          placeholder="credential type a plugin registers, e.g. 'bybit'"
          required
          mono
        />
      )}
      <div className="flex flex-col gap-1">
        <label className="text-xs" style={{ color: 'var(--muted)' }}>Data (JSON)</label>
        <textarea
          value={rawData}
          onChange={(e) => { setRawData(e.target.value); setJsonError('') }}
          rows={4}
          required
          placeholder='{"apiKey": "...", "secret": "..."}'
          className="rounded-md px-3 py-2 text-sm font-mono resize-y"
          style={{
            background: 'var(--background)',
            color: 'var(--foreground)',
            border: `1px solid ${jsonError ? 'var(--danger)' : 'var(--border)'}`,
          }}
        />
        {jsonError && <span className="text-xs" style={{ color: 'var(--danger)' }}>{jsonError}</span>}
      </div>
      <button
        type="submit"
        disabled={loading || !name || !type}
        className="self-end px-4 py-2 rounded-md text-sm"
        style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? 0.6 : 1 }}
      >
        {loading ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}

// ── Add credential ────────────────────────────────────────────────────────────

/**
 * n8n-style type picker: package sidebar + search + type list. Categories are
 * the REGISTERING PLUGINS (built-ins under 'core'); the free-form escape
 * hatch lives under 'custom'.
 */
function TypePicker({
  credentialTypes,
  selected,
  onSelect,
}: {
  credentialTypes: CredentialTypeInfo[]
  selected: string
  onSelect: (type: string) => void
}) {
  const [category, setCategory] = useState<string>('All')
  const [query, setQuery] = useState('')

  const entries = [
    ...credentialTypes.map((t) => ({
      id: t.type,
      label: t.displayName ?? t.type,
      category: t.pluginName ?? 'core',
      kinds: t.kinds,
    })),
    { id: 'other', label: 'Other (free-form)', category: 'custom', kinds: [] as string[] },
  ]

  const categories = ['All', ...Array.from(new Set(entries.map(e => e.category))).sort()]
  const q = query.trim().toLowerCase()
  const visible = entries.filter(e =>
    (category === 'All' || e.category === category) &&
    (q === '' || e.label.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)),
  )

  return (
    <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)', minHeight: 220 }}>
      {/* Category sidebar */}
      <div className="flex flex-col w-40 shrink-0 py-2" style={{ background: 'var(--background)', borderRight: '1px solid var(--border)' }}>
        {categories.map((c) => {
          const count = c === 'All' ? entries.length : entries.filter(e => e.category === c).length
          const active = category === c
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className="flex items-center justify-between px-3 py-1.5 text-sm text-left"
              style={{
                background: active ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'transparent',
                color: active ? 'var(--foreground)' : 'var(--muted)',
                borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
              }}
            >
              {c}
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{count}</span>
            </button>
          )
        })}
      </div>

      {/* Search + type list */}
      <div className="flex-1 flex flex-col">
        <div className="p-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search credential types…"
            className="w-full rounded-md px-3 py-1.5 text-sm"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
        </div>
        <div className="flex-1 overflow-y-auto" style={{ maxHeight: 260 }}>
          {visible.length === 0 && (
            <p className="text-xs px-3 py-4 text-center" style={{ color: 'var(--muted)' }}>No types match “{query}”.</p>
          )}
          {visible.map((e) => {
            const active = selected === e.id
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => onSelect(e.id)}
                className="w-full flex items-center justify-between px-3 py-2 text-left text-sm"
                style={{
                  background: active ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'transparent',
                  color: 'var(--foreground)',
                  borderBottom: '1px solid var(--border)',
                }}
              >
                <span>{e.label}</span>
                <span className="flex gap-1">
                  {e.kinds.map(k => (
                    <span key={k} className="text-[10px] px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
                      {k}
                    </span>
                  ))}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function AddCredentialForm({
  credentialTypes,
  onSuccess,
  onCancel,
}: {
  credentialTypes: CredentialTypeInfo[]
  onSuccess: () => void
  onCancel: () => void
}) {
  const [type, setType] = useState(credentialTypes[0]?.type ?? 'other')
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const selected = credentialTypes.find((t) => t.type === type)

  async function submit(name: string, data: Record<string, unknown>, typeOverride?: string) {
    setLoading(true)
    setSubmitError('')
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: typeOverride || type, data }),
      })
      if (res.ok) {
        onSuccess()
      } else {
        setSubmitError(await res.text() || `Failed to save credential (HTTP ${res.status})`)
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Network error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="rounded-lg p-5 mb-4 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <h2 className="font-semibold text-base">Add Credential</h2>

      {/* Type picker — category sidebar + search (n8n-style) */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Type</label>
        <TypePicker credentialTypes={credentialTypes} selected={type} onSelect={setType} />
      </div>

      {selected?.jsonSchema ? (
        <SchemaCredentialForm key={selected.type} typeInfo={selected} onSubmit={submit} loading={loading} />
      ) : selected ? (
        <GenericCredentialForm key={selected.type} fixedType={selected.type} onSubmit={(n, d, t) => submit(n, d, t)} loading={loading} />
      ) : (
        <GenericCredentialForm key="other" onSubmit={(n, d, t) => submit(n, d, t)} loading={loading} />
      )}

      {submitError && (
        <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
          {submitError}
        </p>
      )}

      <div className="flex justify-start">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function CredentialsClient({ initialCredentials, credentialTypes }: Props) {
  const [credentials, setCredentials] = useState(initialCredentials)
  const [showForm, setShowForm] = useState(false)
  const [listCategory, setListCategory] = useState('All')

  async function refresh() {
    const res = await fetch('/api/credentials')
    if (res.ok) setCredentials(await res.json())
  }

  async function deleteCredential(id: string) {
    await fetch(`/api/credentials/${id}`, { method: 'DELETE' })
    await refresh()
  }

  // Stored credentials grouped by their type's registering plugin
  const categoryOf = (credType: string) =>
    credentialTypes.find(t => t.type === credType)?.pluginName ?? 'custom'
  const listCategories = ['All', ...Array.from(new Set(credentials.map(c => categoryOf(c.type)))).sort()]
  const visibleCredentials = listCategory === 'All'
    ? credentials
    : credentials.filter(c => categoryOf(c.type) === listCategory)

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1">
          {listCategories.map((c) => (
            <button
              key={c}
              onClick={() => setListCategory(c)}
              className="px-3 py-1.5 rounded-md text-xs"
              style={{
                background: listCategory === c ? 'var(--accent)' : 'transparent',
                color: listCategory === c ? '#fff' : 'var(--muted)',
                border: '1px solid var(--border)',
              }}
            >
              {c}
              {c !== 'All' && <span className="ml-1 opacity-70">{credentials.filter(x => categoryOf(x.type) === c).length}</span>}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 rounded-md text-sm transition-colors"
          style={{
            background: showForm ? 'var(--surface)' : 'var(--accent)',
            color: '#fff',
            border: showForm ? '1px solid var(--border)' : 'none',
          }}
        >
          {showForm ? 'Cancel' : '+ Add Credential'}
        </button>
      </div>

      {showForm && (
        <AddCredentialForm
          credentialTypes={credentialTypes}
          onSuccess={() => { setShowForm(false); void refresh() }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {credentials.length === 0 && !showForm ? (
        <div
          className="rounded-lg p-8 text-center text-sm"
          style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px dashed var(--border)' }}
        >
          No credentials stored yet.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {visibleCredentials.map((cred) => (
            <CredentialCard
              key={cred.id}
              credential={cred}
              credentialTypes={credentialTypes}
              onDelete={() => deleteCredential(cred.id)}
              onChanged={() => void refresh()}
            />
          ))}
          {visibleCredentials.length === 0 && (
            <p className="text-sm text-center py-6" style={{ color: 'var(--muted)' }}>
              No {listCategory} credentials.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ── Credential card ───────────────────────────────────────────────────────────

interface CredentialWithPublic extends CredentialInfo {
  publicData?: Record<string, unknown>
}

function CredentialCard({ credential, credentialTypes, onDelete, onChanged }: {
  credential: CredentialWithPublic
  credentialTypes: CredentialTypeInfo[]
  onDelete: () => void
  onChanged: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const typeInfo = credentialTypes.find(t => t.type === credential.type)

  return (
    <div
      className="rounded-lg p-4 flex items-center justify-between gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium">{credential.name}</span>
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}
          >
            {credential.type}
          </span>
        </div>
        <span className="text-xs font-mono" style={{ color: 'var(--muted)', opacity: 0.6 }}>
          {credential.id}
        </span>
        {credential.publicData && Object.keys(credential.publicData).length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-mono">
            {Object.entries(credential.publicData).map(([k, v]) => (
              <span key={k}>
                <span style={{ color: 'var(--muted)' }}>{k}=</span>
                <span style={{ color: 'var(--foreground)' }}>{String(v)}</span>
              </span>
            ))}
          </div>
        )}
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          created {new Date(credential.createdAt).toLocaleString()}
        </span>
        {editing && typeInfo?.jsonSchema && (
          <EditCredentialForm
            credential={credential}
            typeInfo={typeInfo}
            onDone={() => { setEditing(false); onChanged() }}
            onCancel={() => setEditing(false)}
          />
        )}
      </div>
      <div className="shrink-0 flex gap-2">
        {typeInfo?.jsonSchema && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="px-3 py-1.5 rounded-md text-xs"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            Edit
          </button>
        )}
        {confirming ? (
          <>
            <button
              onClick={() => setConfirming(false)}
              className="px-3 py-1.5 rounded-md text-xs"
              style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              Cancel
            </button>
            <button
              onClick={onDelete}
              className="px-3 py-1.5 rounded-md text-xs"
              style={{ background: 'var(--danger)', color: '#fff' }}
            >
              Confirm
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="px-3 py-1.5 rounded-md text-xs"
            style={{ background: '#3f1f1f', color: 'var(--danger)', border: '1px solid #7f1d1d' }}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

// ── Edit form ─────────────────────────────────────────────────────────────────
//
// Non-secret fields prefill from publicData and may be changed freely; secret
// (password) fields start EMPTY and must be re-entered — saving replaces the
// stored encrypted data entirely. Name and type are fixed (instances bind by
// credential name).

function EditCredentialForm({ credential, typeInfo, onDone, onCancel }: {
  credential: CredentialWithPublic
  typeInfo: CredentialTypeInfo
  onDone: () => void
  onCancel: () => void
}) {
  const fields = typeInfo.jsonSchema ? fieldsFromJsonSchema(typeInfo.jsonSchema) : []
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    for (const f of fields) {
      const existing = credential.publicData?.[f.name]
      if (!f.password && existing !== undefined) initial[f.name] = String(existing)
    }
    return initial
  })
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setError('')
    const { data, error: buildError } = buildData(fields, values)
    if (buildError) { setError(buildError); return }
    setSaving(true)
    const res = await fetch(`/api/credentials/${credential.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    })
    setSaving(false)
    if (!res.ok) setError(await res.text())
    else onDone()
  }

  return (
    <div className="mt-2 rounded-md p-3 flex flex-col gap-2" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
      <span className="text-xs" style={{ color: 'var(--warning)' }}>
        Secret fields must be re-entered — saving replaces the stored encrypted data.
      </span>
      {fields.map((field) =>
        field.type === 'boolean' ? (
          <label key={field.name} className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: 'var(--foreground)' }}>
            <input
              type="checkbox"
              checked={(values[field.name] ?? String(field.defaultValue ?? false)) === 'true'}
              onChange={(e) => setValues(v => ({ ...v, [field.name]: String(e.target.checked) }))}
              className="accent-blue-500"
            />
            {field.displayName}
          </label>
        ) : (
          <InputField
            key={field.name}
            label={field.displayName}
            value={values[field.name] ?? ''}
            onChange={(v) => setValues(prev => ({ ...prev, [field.name]: v }))}
            placeholder={field.password ? 're-enter to keep this credential working' : field.placeholder}
            required={field.required || field.password === true}
            type={field.password ? 'password' : field.type === 'number' ? 'number' : 'text'}
            hint={field.description}
            mono
          />
        ),
      )}
      {error && <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</p>}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-xs" style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
          Cancel
        </button>
        <button onClick={() => void save()} disabled={saving} className="px-3 py-1.5 rounded-md text-xs" style={{ background: 'var(--accent)', color: '#fff', opacity: saving ? 0.6 : 1 }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

// ── Shared input ──────────────────────────────────────────────────────────────

function InputField({
  label,
  value,
  onChange,
  placeholder,
  required,
  type = 'text',
  mono,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  required?: boolean
  type?: string
  mono?: boolean
  hint?: string
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs" style={{ color: 'var(--muted)' }}>
        {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
        {hint && <span className="ml-1" style={{ opacity: 0.6 }}>— {hint}</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className={`rounded-md px-3 py-2 text-sm ${mono ? 'font-mono' : ''}`}
        style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
      />
    </div>
  )
}
