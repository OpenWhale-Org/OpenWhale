'use client'

import { useState } from 'react'
import { Modal } from '@/components/Modal'
import { KebabMenu, MENU_ITEM } from '@/components/CardMenu'
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
  submitError,
}: {
  typeInfo: CredentialTypeInfo
  onSubmit: (name: string, data: Record<string, unknown>) => Promise<void>
  loading: boolean
  /** Raised by the caller's POST. Shown in the footer, beside the button it belongs to. */
  submitError?: string
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
    /* Fields scroll, actions do not. Save at the end of a long form is Save you
       have to go looking for — on a venue with six fields it was already off
       the bottom of the dialog when it opened. */
    <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden flex flex-col gap-3 px-5 py-4">
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

      </div>

      <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--border)' }}>
        {submitError && (
          <span className="flex-1 min-w-0 text-xs truncate" style={{ color: 'var(--danger)' }} title={submitError}>
            {submitError}
          </span>
        )}
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
  submitError,
}: {
  submitError?: string
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
    <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden flex flex-col gap-3 px-5 py-4">
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
      </div>

      <div className="shrink-0 flex items-center justify-end gap-2 px-5 py-3" style={{ borderTop: '1px solid var(--border)' }}>
        {submitError && (
          <span className="flex-1 min-w-0 text-xs truncate" style={{ color: 'var(--danger)' }} title={submitError}>
            {submitError}
          </span>
        )}
        <button
          type="submit"
          disabled={loading || !name || !type}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? 'Saving…' : 'Save'}
        </button>
      </div>
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

  const entries: TypeEntry[] = [
    ...credentialTypes.map((t) => ({
      id: t.type,
      label: t.displayName ?? t.type,
      category: t.pluginName ?? 'core',
      kinds: t.kinds,
      ...(t.logo !== undefined ? { logo: t.logo } : {}),
      ...(t.icon !== undefined ? { icon: t.icon } : {}),
      ...(t.description !== undefined ? { description: t.description } : {}),
    })),
    {
      id: 'other',
      label: 'Other (free-form)',
      category: 'custom',
      kinds: [] as string[],
      icon: '📄',
      description: 'Store any JSON under a name. No schema, no form, no test.',
    },
  ]

  const categories = ['All', ...Array.from(new Set(entries.map(e => e.category))).sort()]
  const q = query.trim().toLowerCase()
  const visible = entries.filter(e =>
    (category === 'All' || e.category === category) &&
    (q === '' || e.label.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)),
  )

  return (
    /* Fills the dialog body: the list is the step, so it should end where the
       dialog does rather than at some fixed pixel height with dead space under
       it. Both columns scroll inside themselves, without a visible track. */
    <div className="flex-1 min-h-0 flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      {/* Category sidebar */}
      <div className="flex flex-col w-40 shrink-0 py-2 overflow-y-auto scroll-hidden" style={{ background: 'var(--background)', borderRight: '1px solid var(--border)' }}>
        {categories.map((c) => {
          const count = c === 'All' ? entries.length : entries.filter(e => e.category === c).length
          const active = category === c
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className="flex items-center justify-between px-3 py-1.5 text-sm text-left shrink-0"
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
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="p-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search credential types…"
            className="w-full rounded-md px-3 py-1.5 text-sm"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
          {visible.length === 0 && (
            <p className="text-xs px-3 py-4 text-center" style={{ color: 'var(--muted)' }}>No types match “{query}”.</p>
          )}
          {visible.map((e) => (
            <TypeRow key={e.id} entry={e} active={selected === e.id} onSelect={() => onSelect(e.id)} />
          ))}
        </div>
      </div>
    </div>
  )
}

interface TypeEntry {
  id: string
  label: string
  category: string
  kinds: string[]
  logo?: string
  icon?: string
  description?: string
}

/**
 * A type's mark: its logo, else its glyph, else the first letter of its name.
 *
 * The letter is drawn in a bordered chip so it reads as a mark rather than as
 * a stray character next to the name, and a logo that fails to load falls back
 * to the same chain — a broken image never leaves a hole in the row.
 */
function TypeMark({ logo, icon, label, size = 22 }: {
  logo?: string | undefined
  icon?: string | undefined
  label: string
  size?: number
}) {
  const [broken, setBroken] = useState(false)
  const showLogo = logo !== undefined && !broken

  if (showLogo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- logos come from
      // plugins as URLs or data: URIs; next/image needs build-time known hosts.
      <img
        src={logo}
        alt=""
        onError={() => setBroken(true)}
        className="shrink-0 object-contain"
        style={{ width: size, height: size, borderRadius: Math.round(size / 4) }}
      />
    )
  }
  if (icon !== undefined) {
    return (
      <span className="shrink-0 grid place-items-center" style={{ width: size, height: size, fontSize: Math.round(size * 0.73), lineHeight: 1 }} aria-hidden>
        {icon}
      </span>
    )
  }
  return (
    <span
      className="shrink-0 grid place-items-center"
      style={{
        width: size, height: size, borderRadius: Math.round(size / 3.6),
        fontSize: Math.round(size * 0.5), fontWeight: 600,
        background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)',
      }}
      aria-hidden
    >
      {(Array.from(label)[0] ?? '?').toUpperCase()}
    </span>
  )
}

/** One row: mark, name, the kinds it can materialize into, and its blurb. */
function TypeRow({ entry, active, onSelect }: { entry: TypeEntry; active: boolean; onSelect: () => void }) {
  const [showDescription, setShowDescription] = useState(false)

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button
        type="button"
        onClick={onSelect}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm"
        style={{
          background: active ? 'color-mix(in srgb, var(--accent) 22%, transparent)' : 'transparent',
          color: 'var(--foreground)',
        }}
      >
        <TypeMark logo={entry.logo} icon={entry.icon} label={entry.label} />
        <span className="flex-1 min-w-0 truncate">{entry.label}</span>
        <span className="flex gap-1 shrink-0">
          {entry.kinds.map(k => (
            <span key={k} className="text-xs px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}>
              {k}
            </span>
          ))}
        </span>
        {entry.description && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(ev) => { ev.stopPropagation(); setShowDescription(v => !v) }}
            className="shrink-0 w-4 h-4 grid place-items-center rounded-full text-xs"
            style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
            title={showDescription ? 'Hide description' : 'What is this?'}
          >
            ?
          </span>
        )}
      </button>
      {showDescription && entry.description && (
        <p className="text-xs px-3 pb-2 pl-[3.1rem]" style={{ color: 'var(--muted)' }}>{entry.description}</p>
      )}
    </div>
  )
}

/**
 * Two steps, like a new strategy instance: pick the type, then fill its form.
 *
 * One dialog across both — remounting the shell between steps would replay the
 * open animation and lose the scroll position. Going back keeps the type
 * selected, so a mis-click costs one click rather than the whole form.
 */
function AddCredentialForm({
  credentialTypes,
  onSuccess,
  onCancel,
}: {
  credentialTypes: CredentialTypeInfo[]
  onSuccess: () => void
  onCancel: () => void
}) {
  const [step, setStep] = useState<'type' | 'fields'>('type')
  const [type, setType] = useState(credentialTypes[0]?.type ?? 'other')
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const selected = credentialTypes.find((t) => t.type === type)
  const label = selected?.displayName ?? (type === 'other' ? 'Other (free-form)' : type)

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
    <Modal onClose={onCancel} maxWidth="46rem" height="min(82vh, 46rem)">
      <div className="flex items-center gap-2 px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        {step === 'fields' && (
          <button
            type="button"
            onClick={() => setStep('type')}
            className="w-7 h-7 rounded-md flex items-center justify-center leading-none shrink-0"
            style={{ color: 'var(--muted)', border: '1px solid var(--border)' }}
            title="Back to types"
            aria-label="Back to types"
          >
            ‹
          </button>
        )}
        <h2 className="font-semibold text-base flex-1 min-w-0 truncate">
          {step === 'type' ? 'Add Credential' : `Add ${label}`}
        </h2>
        <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
          {step === 'type' ? 'Step 1 of 2' : 'Step 2 of 2'}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="w-7 h-7 rounded-md flex items-center justify-center leading-none shrink-0"
          style={{ color: 'var(--muted)' }}
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {step === 'type' ? (
        <div className="flex-1 min-h-0 flex flex-col gap-3 px-5 py-4">
          <p className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
            Pick what this credential is for. The next step is its form.
          </p>
          <TypePicker
            credentialTypes={credentialTypes}
            selected={type}
            onSelect={(t) => { setType(t); setSubmitError(''); setStep('fields') }}
          />
        </div>
      ) : (
        /* No scrolling here — the form inside owns it, so its action bar can
           stay pinned to the bottom of the dialog. */
        <div className="flex-1 min-h-0 flex flex-col">
          <div className="flex items-center gap-2.5 px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
            <TypeMark
              logo={selected?.logo}
              icon={selected?.icon ?? (type === 'other' ? '📄' : undefined)}
              label={label}
              size={26}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{label}</div>
              {selected?.description && (
                <div className="text-xs" style={{ color: 'var(--muted)' }}>{selected.description}</div>
              )}
            </div>
            {selected?.documentationUrl && (
              <a
                href={selected.documentationUrl}
                target="_blank"
                rel="noreferrer"
                className="ml-auto text-xs shrink-0 underline"
                style={{ color: 'var(--muted)' }}
              >
                Docs ↗
              </a>
            )}
          </div>

          {selected?.jsonSchema ? (
            <SchemaCredentialForm key={selected.type} typeInfo={selected} onSubmit={submit} loading={loading} submitError={submitError} />
          ) : selected ? (
            <GenericCredentialForm key={selected.type} fixedType={selected.type} onSubmit={(n, d, t) => submit(n, d, t)} loading={loading} submitError={submitError} />
          ) : (
            <GenericCredentialForm key="other" onSubmit={(n, d, t) => submit(n, d, t)} loading={loading} submitError={submitError} />
          )}
        </div>
      )}
    </Modal>
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
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowForm(true)}
            className="px-4 py-2 rounded-md text-sm"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            + Add Credential
          </button>
        </div>
      </div>

      {showForm && (
        <AddCredentialForm
          credentialTypes={credentialTypes}
          onSuccess={() => { setShowForm(false); void refresh() }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {credentials.length === 0 ? (
        <div
          className="rounded-lg p-8 text-center text-sm"
          style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px dashed var(--border)' }}
        >
          No credentials stored yet.
        </div>
      ) : (
        /* Rows only. A credential is a name, a few public fields and a date —
           a grid of cards would spread that across a lot of empty space and
           make the fields harder to scan down the page. */
        <div className="flex flex-col gap-2">
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
  const [editing, setEditing] = useState(false)
  const typeInfo = credentialTypes.find(t => t.type === credential.type)

  /* Same header grammar as a strategy card: identity on the left, the ⋯ menu
     on the right. Edit and a bare red Delete used to sit side by side in the
     corner, which is the arrangement that page moved away from — one slip
     apart from each other. */
  const menu = (
    <CredentialMenu
      canEdit={Boolean(typeInfo?.jsonSchema) && !editing}
      onEdit={() => setEditing(true)}
      onDelete={onDelete}
    />
  )

  const identity = (
    <div className="flex items-center gap-2 min-w-0">
      <span className="font-medium truncate" title={credential.name}>{credential.name}</span>
      <span
        className="text-xs px-1.5 py-0.5 rounded shrink-0"
        style={{ background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)' }}
      >
        {credential.type}
      </span>
    </div>
  )

  const publicFields = credential.publicData && Object.keys(credential.publicData).length > 0
    ? (
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs font-mono min-w-0">
        {Object.entries(credential.publicData).map(([k, v]) => (
          <span key={k} className="truncate">
            <span style={{ color: 'var(--muted)' }}>{k}=</span>
            <span style={{ color: 'var(--foreground)' }}>{String(v)}</span>
          </span>
        ))}
      </div>
    )
    : null

  const editor = editing && typeInfo?.jsonSchema && (
    <EditCredentialForm
      credential={credential}
      typeInfo={typeInfo}
      onDone={() => { setEditing(false); onChanged() }}
      onCancel={() => setEditing(false)}
    />
  )

  return (
    <div
      className="rounded-md px-3 py-2"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* Deterministic tracks, as on the strategies list: an `auto` track is
          sized by its OWN row, which is what makes columns stagger. */}
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,2fr) 11rem 2rem' }}>
        {identity}
        {publicFields ?? <span />}
        <span className="text-xs truncate" style={{ color: 'var(--muted)' }}>
          {new Date(credential.createdAt).toLocaleString()}
        </span>
        <div className="flex justify-end">{menu}</div>
      </div>
      {editor}
    </div>
  )
}

/** Edit and a two-step Delete, behind the same ⋯ every other card uses. */
function CredentialMenu({ canEdit, onEdit, onDelete }: {
  canEdit: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <KebabMenu>
      {(close) => (
        <>
          {canEdit && (
            <button type="button" className={MENU_ITEM} style={{ color: 'var(--foreground)' }}
              onClick={() => { onEdit(); close() }}>
              Edit
            </button>
          )}
          <button
            type="button"
            className={MENU_ITEM}
            style={{ color: 'var(--danger)', ...(canEdit ? { borderTop: '1px solid var(--border)' } : {}) }}
            onClick={() => {
              if (!confirming) { setConfirming(true); return }
              onDelete(); close(); setConfirming(false)
            }}
          >
            {confirming ? 'Delete for good?' : 'Delete'}
          </button>
        </>
      )}
    </KebabMenu>
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
