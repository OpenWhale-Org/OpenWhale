'use client'

import { useState, useEffect } from 'react'
import { Rail, RailItem } from '../../components/Rail'
import { Modal } from '@/components/Modal'
import { KebabMenu, MENU_ITEM } from '@/components/CardMenu'
import { TypeMark } from '@/components/TypeMark'
import type { CredentialInfo } from '@openwhaleorg/core'
import type { CredentialTypeInfo } from '@/lib/core-types'
import { Switch } from '@/components/Switch'
import { useT } from '@/i18n'
import { fmtDateTime } from '@/lib/time'

type T = ReturnType<typeof useT>

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
function buildData(fields: FieldSpec[], values: Record<string, string>, t: T): { data: Record<string, unknown>; error?: string } {
  const data: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.type === 'boolean') {
      data[field.name] = (values[field.name] ?? String(field.defaultValue ?? false)) === 'true'
      continue
    }
    const raw = (values[field.name] ?? '').trim()
    if (raw === '') {
      if (field.required) return { data, error: t('credentials.field.required', { field: field.displayName }) }
      continue
    }
    if (field.pattern && !new RegExp(field.pattern).test(raw))
      return { data, error: t('credentials.field.format', { field: field.displayName }) }
    if (field.type === 'number') {
      const n = parseFloat(raw)
      if (isNaN(n)) return { data, error: t('credentials.field.number', { field: field.displayName }) }
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
  initialName,
  initialValues,
}: {
  typeInfo: CredentialTypeInfo
  onSubmit: (name: string, data: Record<string, unknown>) => Promise<void>
  loading: boolean
  /** Seeds for a duplicate. Secrets are never among them — see the menu item. */
  initialName?: string
  initialValues?: Record<string, string>
  /** Raised by the caller's POST. Shown in the footer, beside the button it belongs to. */
  submitError?: string
}) {
  const t = useT()
  const fields = typeInfo.jsonSchema ? fieldsFromJsonSchema(typeInfo.jsonSchema) : []
  const [name, setName] = useState(initialName ?? '')
  const [values, setValues] = useState<Record<string, string>>(initialValues ?? {})
  const [error, setError] = useState('')
  const [testState, setTestState] = useState<'idle' | 'running' | 'ok' | 'failed'>('idle')
  const [testMessage, setTestMessage] = useState('')

  function set(field: string, value: string) {
    setValues((v) => ({ ...v, [field]: value }))
    setTestState('idle')
  }

  // The tour can fill the form (a generated testnet wallet): name only when
  // still empty, field values merged over what is typed.
  useEffect(() => {
    const onFill = (e: Event) => {
      const d = (e as CustomEvent<{ name?: string; values?: Record<string, string> }>).detail
      if (d?.name) setName(n => n || d.name!)
      if (d?.values) setValues(v => ({ ...v, ...d.values }))
      setTestState('idle')
    }
    window.addEventListener('ow-tour-fill', onFill)
    return () => window.removeEventListener('ow-tour-fill', onFill)
  }, [])

  function assemble(): Record<string, unknown> | null {
    const { data, error: buildError } = buildData(fields, values, t)
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
      setTestMessage(err instanceof Error ? err.message : t('credentials.networkError'))
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
              {t('credentials.docs')}
            </a>
          )}
        </div>
      )}

      <InputField label={t('credentials.name')} value={name} onChange={setName} placeholder={t('credentials.namePlaceholder', { example: typeInfo.displayName ?? typeInfo.type })} required />

      {fields.map((field) =>
        field.type === 'boolean' ? (
          <Switch
            key={field.name}
            checked={(values[field.name] ?? String(field.defaultValue ?? false)) === 'true'}
            onChange={(next) => set(field.name, String(next))}
            label={field.displayName}
            {...(field.description ? { hint: field.description } : {})}
          />
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
          {t('credentials.testPassed')}
        </p>
      )}
      {testState === 'failed' && (
        <p className="text-xs px-3 py-2 rounded-md whitespace-pre-wrap" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
          {t('credentials.testFailed', { message: testMessage })}
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
            {testState === 'running' ? t('credentials.testing') : t('credentials.test')}
          </button>
        )}
        <button
          type="submit"
          disabled={loading || !name}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? 0.6 : 1 }}
        >
          {loading ? t('common.saving') : t('common.save')}
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
  const t = useT()
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
      setJsonError(t('credentials.invalidJson'))
      return
    }
    await onSubmit(name, data, type)
  }

  return (
    <form onSubmit={handleSubmit} className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden flex flex-col gap-3 px-5 py-4">
      <InputField label={t('credentials.name')} value={name} onChange={setName} placeholder={t('credentials.generic.namePlaceholder')} required />
      {!fixedType && (
        <InputField
          label={t('credentials.type')}
          value={customType}
          onChange={setCustomType}
          placeholder={t('credentials.typePlaceholder')}
          required
          mono
        />
      )}
      <div className="flex flex-col gap-1">
        <label className="text-xs" style={{ color: 'var(--muted)' }}>{t('credentials.dataJson')}</label>
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
          {loading ? t('common.saving') : t('common.save')}
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
  const t = useT()
  const [category, setCategory] = useState<string>('All')
  const [query, setQuery] = useState('')

  const entries: TypeEntry[] = [
    // Managed types (created by a script/flow, e.g. a venue's agent key) are
    // not offered for hand entry — the flow that makes them is the entry point.
    ...credentialTypes.filter((ct) => !ct.managed).map((ct) => ({
      id: ct.type,
      label: ct.displayName ?? ct.type,
      // The registering package is only the default answer; a type that says
      // what it actually is wins.
      category: ct.category ?? ct.pluginName ?? 'core',
      kinds: ct.kinds,
      ...(ct.logo !== undefined ? { logo: ct.logo } : {}),
      ...(ct.icon !== undefined ? { icon: ct.icon } : {}),
      ...(ct.description !== undefined ? { description: ct.description } : {}),
    })),
    {
      id: 'other',
      label: t('credentials.other'),
      category: 'custom',
      kinds: [] as string[],
      icon: '📄',
      description: t('credentials.otherDesc'),
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
    <div data-tour="credential-type-list" className="flex-1 min-h-0 flex rounded-md overflow-hidden" style={{ border: '1px solid var(--border)' }}>
      {/* Category sidebar */}
      <Rail bare width="10rem">
        {categories.map((c) => {
          const count = c === 'All' ? entries.length : entries.filter(e => e.category === c).length
          return (
            <RailItem
              key={c}
              active={category === c}
              onClick={() => setCategory(c)}
              title={c === 'All' ? t('credentials.all') : c}
              right={count}
            />
          )
        })}
      </Rail>

      {/* Search + type list */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div className="p-2 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('credentials.searchTypes')}
            className="w-full rounded-md px-3 py-1.5 text-sm"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto scroll-hidden">
          {visible.length === 0 && (
            <p className="text-xs px-3 py-4 text-center" style={{ color: 'var(--muted)' }}>{t('credentials.noTypesMatch', { query })}</p>
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

/** One row: mark, name, the kinds it can materialize into, and its blurb. */
function TypeRow({ entry, active, onSelect }: { entry: TypeEntry; active: boolean; onSelect: () => void }) {
  const t = useT()
  const [showDescription, setShowDescription] = useState(false)

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button
        type="button"
        onClick={onSelect}
        className="hoverable hoverable-flat w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm"
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
            title={showDescription ? t('credentials.hideDesc') : t('credentials.whatIsThis')}
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
  const t = useT()
  const [step, setStep] = useState<'type' | 'fields'>('type')
  const [type, setType] = useState(credentialTypes[0]?.type ?? 'other')
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')

  const selected = credentialTypes.find((ct) => ct.type === type)
  const label = selected?.displayName ?? (type === 'other' ? t('credentials.other') : type)

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
        setSubmitError(await res.text() || t('credentials.saveFailed', { status: res.status }))
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('credentials.networkError'))
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
            title={t('credentials.backToTypes')}
            aria-label={t('credentials.backToTypes')}
          >
            ‹
          </button>
        )}
        <h2 className="font-semibold text-base flex-1 min-w-0 truncate">
          {step === 'type' ? t('credentials.add') : t('credentials.addType', { label })}
        </h2>
        <span className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
          {t('instance.step', { n: step === 'type' ? 1 : 2, total: 2 })}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="w-7 h-7 rounded-md flex items-center justify-center leading-none shrink-0"
          style={{ color: 'var(--muted)' }}
          aria-label={t('common.close')}
        >
          ✕
        </button>
      </div>

      {step === 'type' ? (
        <div data-tour="credential-dialog" className="flex-1 min-h-0 flex flex-col gap-3 px-5 py-4">
          <p className="text-xs shrink-0" style={{ color: 'var(--muted)' }}>
            {t('credentials.pickPurpose')}
          </p>
          <TypePicker
            credentialTypes={credentialTypes}
            selected={type}
            onSelect={(next) => { setType(next); setSubmitError(''); setStep('fields') }}
          />
        </div>
      ) : (
        /* No scrolling here — the form inside owns it, so its action bar can
           stay pinned to the bottom of the dialog. */
        <div data-tour="credential-form" className="flex-1 min-h-0 flex flex-col">
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
                {t('credentials.docsLink')}
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
  const t = useT()
  const [credentials, setCredentials] = useState(initialCredentials)
  const [showForm, setShowForm] = useState(false)
  const [duplicating, setDuplicating] = useState<CredentialWithPublic | null>(null)
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
  const categoryOf = (credType: string) => {
    const t = credentialTypes.find(x => x.type === credType)
    return t?.category ?? t?.pluginName ?? 'custom'
  }
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
              {c === 'All' ? t('credentials.all') : c}
              {c !== 'All' && <span className="ml-1 opacity-70">{credentials.filter(x => categoryOf(x.type) === c).length}</span>}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            data-tour="add-credential"
            onClick={() => setShowForm(true)}
            className="px-4 py-2 rounded-md text-sm"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {t('credentials.addButton')}
          </button>
        </div>
      </div>

      {duplicating && (
        <DuplicateCredentialForm
          source={duplicating}
          credentialTypes={credentialTypes}
          onSuccess={() => { setDuplicating(null); void refresh() }}
          onCancel={() => setDuplicating(null)}
        />
      )}

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
          {t('credentials.empty')}
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
              onDuplicate={() => setDuplicating(cred)}
              onDelete={() => deleteCredential(cred.id)}
              onChanged={() => void refresh()}
            />
          ))}
          {visibleCredentials.length === 0 && (
            <p className="text-sm text-center py-6" style={{ color: 'var(--muted)' }}>
              {t('credentials.noneInCategory', { category: listCategory })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Duplicate: a new credential of the same type, public fields carried across.
 *
 * The secrets are NOT carried, and cannot be — they are stored encrypted and
 * the browser has only ever seen `publicData`. So this is a create form with
 * the boring parts filled in, not a clone; the point is "same venue, another
 * key" without retyping a base URL or a wallet address.
 */
function DuplicateCredentialForm({ source, credentialTypes, onSuccess, onCancel }: {
  source: CredentialWithPublic
  credentialTypes: CredentialTypeInfo[]
  onSuccess: () => void
  onCancel: () => void
}) {
  const t = useT()
  const [loading, setLoading] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const typeInfo = credentialTypes.find(ct => ct.type === source.type)
  const seeded: Record<string, string> = {}
  for (const [k, v] of Object.entries(source.publicData ?? {})) seeded[k] = String(v)

  async function submit(name: string, data: Record<string, unknown>, typeOverride?: string) {
    setLoading(true)
    setSubmitError('')
    try {
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type: typeOverride || source.type, data }),
      })
      if (res.ok) onSuccess()
      else setSubmitError(await res.text() || t('credentials.saveFailed', { status: res.status }))
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : t('credentials.networkError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal onClose={onCancel} maxWidth="46rem" height="min(82vh, 46rem)">
      <div className="flex items-center gap-2 px-5 py-3 shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
        <TypeMark
          logo={typeInfo?.logo}
          icon={typeInfo?.icon}
          label={typeInfo?.displayName ?? source.type}
          size={26}
        />
        <h2 className="font-semibold text-base flex-1 min-w-0 truncate">{t('credentials.duplicate', { name: source.name })}</h2>
        <button
          type="button"
          onClick={onCancel}
          className="w-7 h-7 rounded-md flex items-center justify-center leading-none shrink-0"
          style={{ color: 'var(--muted)' }}
          aria-label={t('common.close')}
        >
          ✕
        </button>
      </div>

      <div className="px-5 pt-3 shrink-0">
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          {t('credentials.duplicateHint')}
        </p>
      </div>

      {typeInfo?.jsonSchema ? (
        <SchemaCredentialForm
          typeInfo={typeInfo}
          onSubmit={submit}
          loading={loading}
          submitError={submitError}
          initialName={t('credentials.copySuffix', { name: source.name })}
          initialValues={seeded}
        />
      ) : (
        <GenericCredentialForm
          fixedType={source.type}
          onSubmit={(n, d, t) => submit(n, d, t)}
          loading={loading}
          submitError={submitError}
        />
      )}
    </Modal>
  )
}

// ── Credential card ───────────────────────────────────────────────────────────

interface CredentialWithPublic extends CredentialInfo {
  publicData?: Record<string, unknown>
}

function CredentialCard({ credential, credentialTypes, onDuplicate, onDelete, onChanged }: {
  credential: CredentialWithPublic
  credentialTypes: CredentialTypeInfo[]
  onDuplicate: () => void
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
      onDuplicate={onDuplicate}
      onDelete={onDelete}
    />
  )

  const identity = (
    <div className="flex items-center gap-2 min-w-0">
      {/* Same mark the picker shows for this type, so a row is recognisable
          by its brand rather than by reading the chip beside the name. */}
      <TypeMark
        logo={typeInfo?.logo}
        icon={typeInfo?.icon}
        label={typeInfo?.displayName ?? credential.type}
        size={22}
      />
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
      className="hoverable hoverable-flat rounded-md px-3 py-2"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* Deterministic tracks, as on the strategies list: an `auto` track is
          sized by its OWN row, which is what makes columns stagger. */}
      <div className="grid items-center gap-3" style={{ gridTemplateColumns: 'minmax(0,1.2fr) minmax(0,2fr) 11rem 2rem' }}>
        {identity}
        {publicFields ?? <span />}
        <span className="text-xs truncate" style={{ color: 'var(--muted)' }}>
          {fmtDateTime(credential.createdAt)}
        </span>
        <div className="flex justify-end">{menu}</div>
      </div>
      {editor}
    </div>
  )
}

/** Edit and a two-step Delete, behind the same ⋯ every other card uses. */
function CredentialMenu({ canEdit, onEdit, onDuplicate, onDelete }: {
  canEdit: boolean
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  return (
    <KebabMenu>
      {(close) => (
        <>
          {canEdit && (
            <button type="button" className={MENU_ITEM} style={{ color: 'var(--foreground)' }}
              onClick={() => { onEdit(); close() }}>
              {t('common.edit')}
            </button>
          )}
          {/* Copies the type and every public field; the secrets stay behind,
              because they are stored encrypted and the browser has never had
              them. "Same venue, another key" is the case this serves. */}
          <button type="button" className={MENU_ITEM} style={{ color: 'var(--foreground)' }}
            onClick={() => { onDuplicate(); close() }}
            title={t('credentials.duplicateTitle')}>
            {t('credentials.duplicateAction')}
          </button>
          <button
            type="button"
            className={MENU_ITEM}
            style={{ color: 'var(--danger)', ...(canEdit ? { borderTop: '1px solid var(--border)' } : {}) }}
            onClick={() => {
              if (!confirming) { setConfirming(true); return }
              onDelete(); close(); setConfirming(false)
            }}
          >
            {confirming ? t('common.deleteConfirm') : t('common.delete')}
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
  const t = useT()
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
    const { data, error: buildError } = buildData(fields, values, t)
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
        {t('credentials.edit.warning')}
      </span>
      {fields.map((field) =>
        field.type === 'boolean' ? (
          <Switch
            key={field.name}
            checked={(values[field.name] ?? String(field.defaultValue ?? false)) === 'true'}
            onChange={(next) => setValues(v => ({ ...v, [field.name]: String(next) }))}
            label={field.displayName}
          />
        ) : (
          <InputField
            key={field.name}
            label={field.displayName}
            value={values[field.name] ?? ''}
            onChange={(v) => setValues(prev => ({ ...prev, [field.name]: v }))}
            placeholder={field.password ? t('credentials.edit.secretPlaceholder') : field.placeholder}
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
          {t('common.cancel')}
        </button>
        <button onClick={() => void save()} disabled={saving} className="px-3 py-1.5 rounded-md text-xs" style={{ background: 'var(--accent)', color: '#fff', opacity: saving ? 0.6 : 1 }}>
          {saving ? t('common.saving') : t('common.save')}
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
