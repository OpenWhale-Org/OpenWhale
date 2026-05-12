'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { StrategyInstance } from '@openwhale/core'
import type { StrategyDefinition, CredentialInfo, ParamFieldDef, ExecutionResult } from '@openwhale/core'

// ── SSE event types ───────────────────────────────────────────────────────────

interface MonitorEmitEvent {
  type: 'monitor_emit'
  monitor: string
  key: string
  data: unknown
  ts: number
}

interface StrategyRunEvent {
  type: 'strategy_run'
  instanceId: string
  triggerId: string
  monitorData: Record<string, unknown>
  instructions: Array<{ action: string; executorId: string; params: Record<string, unknown> }>
  timestamp: number
}

type LiveEvent = MonitorEmitEvent | StrategyRunEvent

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

interface Props {
  initialInstances: StrategyInstance[]
}

// ── Generic param fields form ─────────────────────────────────────────────────

function isFieldVisible(field: ParamFieldDef, values: Record<string, string>): boolean {
  const { displayOptions } = field
  if (!displayOptions) return true

  if (displayOptions.show) {
    for (const [key, allowed] of Object.entries(displayOptions.show)) {
      const current = values[key] ?? ''
      if (!allowed.map(String).includes(current)) return false
    }
  }
  if (displayOptions.hide) {
    for (const [key, blocked] of Object.entries(displayOptions.hide)) {
      const current = values[key] ?? ''
      if (blocked.map(String).includes(current)) return false
    }
  }
  return true
}

function ParamFieldsForm({
  fields,
  values,
  onChange,
}: {
  fields: ParamFieldDef[]
  values: Record<string, string>
  onChange: (v: Record<string, string>) => void
}) {
  const baseFields = fields.filter((f) => f.group === 'base')
  const tunableFields = fields.filter((f) => f.group === 'tunable')

  function set(name: string, value: string) {
    onChange({ ...values, [name]: value })
  }

  function renderField(field: ParamFieldDef) {
    if (!isFieldVisible(field, values)) return null
    const value = values[field.name] ?? ''

    if (field.type === 'boolean') {
      const checked = value === 'true'
      return (
        <div key={field.name} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
              {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
            </span>
            {field.hint && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.hint}</span>}
          </div>
          <button
            type="button"
            onClick={() => set(field.name, checked ? 'false' : 'true')}
            className="relative w-10 h-5 rounded-full transition-colors self-start"
            style={{ background: checked ? 'var(--accent)' : 'var(--border)' }}
          >
            <span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
              style={{ transform: checked ? 'translateX(1.25rem)' : 'translateX(0.125rem)' }}
            />
          </button>
          {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
        </div>
      )
    }

    if (field.type === 'options' && field.options) {
      return (
        <div key={field.name} className="flex flex-col gap-1">
          <div className="flex items-baseline gap-1">
            <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
              {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
            </span>
            {field.hint && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.hint}</span>}
          </div>
          <select
            value={value}
            onChange={(e) => set(field.name, e.target.value)}
            required={field.required}
            className="rounded-md px-3 py-2 text-sm"
            style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            {field.options.map((opt) => (
              <option key={String(opt.value)} value={String(opt.value)}>{opt.label}</option>
            ))}
          </select>
          {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
        </div>
      )
    }

    // string / number
    return (
      <div key={field.name} className="flex flex-col gap-1">
        <div className="flex items-baseline gap-1">
          <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>
            {field.displayName}{field.required && <span style={{ color: 'var(--danger)' }}> *</span>}
          </span>
          {field.hint && <span className="text-xs" style={{ color: 'var(--muted)' }}>— {field.hint}</span>}
        </div>
        <input
          type={field.type === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(e) => set(field.name, e.target.value)}
          placeholder={field.placeholder ?? (field.default !== undefined ? String(field.default) : undefined)}
          required={field.required}
          step={field.type === 'number' ? 'any' : undefined}
          className="rounded-md px-3 py-2 text-sm"
          style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        />
        {field.description && <span className="text-xs" style={{ color: 'var(--muted)' }}>{field.description}</span>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {baseFields.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Base Parameters</label>
          <div className="rounded-md p-3 flex flex-col gap-3" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
            {baseFields.map(renderField)}
          </div>
        </div>
      )}
      {tunableFields.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Tunable Parameters</label>
          <div className="rounded-md p-3 flex flex-col gap-3" style={{ background: 'var(--background)', border: '1px solid var(--border)' }}>
            {tunableFields.map(renderField)}
          </div>
        </div>
      )}
    </div>
  )
}

/** Convert flat string values map → { base, tunable } params object */
function buildParamsFromFields(
  fields: ParamFieldDef[],
  values: Record<string, string>,
): { base: Record<string, unknown>; tunable: Record<string, unknown> } {
  const base: Record<string, unknown> = {}
  const tunable: Record<string, unknown> = {}

  for (const field of fields) {
    const raw = values[field.name]
    if (raw === undefined || raw === '') continue
    let parsed: unknown = raw
    if (field.type === 'number') {
      const n = parseFloat(raw)
      if (!isNaN(n)) parsed = n
    } else if (field.type === 'boolean') {
      parsed = raw === 'true'
    }
    if (field.group === 'base') base[field.name] = parsed
    else tunable[field.name] = parsed
  }

  return { base, tunable }
}

/** Initialise string values from field defaults */
function defaultFieldValues(fields: ParamFieldDef[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    if (f.default !== undefined) out[f.name] = String(f.default)
  }
  return out
}

// ── Main component ────────────────────────────────────────────────────────────

export function InstancesClient({ initialInstances }: Props) {
  const [instances, setInstances] = useState(initialInstances)
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/instances')
    if (res.ok) setInstances(await res.json())
    setLoading(false)
  }, [])

  async function deactivate(id: string) {
    await fetch(`/api/instances/${id}`, { method: 'DELETE' })
    await refresh()
  }

  return (
    <div>
      <div className="flex justify-end gap-2 mb-4">
        <button
          onClick={refresh}
          disabled={loading}
          className="px-4 py-2 rounded-md text-sm transition-colors"
          style={{ background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 rounded-md text-sm transition-colors"
          style={{ background: showForm ? 'var(--surface)' : 'var(--accent)', color: '#fff', border: showForm ? '1px solid var(--border)' : 'none' }}
        >
          {showForm ? 'Cancel' : '+ New Instance'}
        </button>
      </div>

      {showForm && (
        <NewInstanceForm
          onSuccess={() => { setShowForm(false); void refresh() }}
          onCancel={() => setShowForm(false)}
        />
      )}

      {instances.length === 0 && !showForm ? (
        <EmptyState onNew={() => setShowForm(true)} />
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          {instances.map((inst) => (
            <InstanceCard key={inst.id} instance={inst} onDeactivate={() => deactivate(inst.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── New instance form ─────────────────────────────────────────────────────────

function NewInstanceForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [strategies, setStrategies] = useState<StrategyDefinition[]>([])
  const [credentials, setCredentials] = useState<CredentialInfo[]>([])
  const [selectedStrategy, setSelectedStrategy] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([])
  // Generic field values for strategies with paramsFields
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({})
  // JSON fallback for strategies without paramsFields
  const [baseParams, setBaseParams] = useState('{}')
  const [tunableParams, setTunableParams] = useState('{}')
  const [enabled, setEnabled] = useState(true)
  const [baseError, setBaseError] = useState('')
  const [tunableError, setTunableError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void Promise.all([
      fetch('/api/strategies').then((r) => r.json() as Promise<StrategyDefinition[]>),
      fetch('/api/credentials').then((r) => r.json() as Promise<CredentialInfo[]>),
    ]).then(([s, c]) => {
      setStrategies(s)
      setCredentials(c)
      if (s.length > 0) {
        const first = s[0]!
        setSelectedStrategy(first.id)
        if (first.paramsFields) setFieldValues(defaultFieldValues(first.paramsFields))
      }
    })
  }, [])

  // Reset field values when strategy changes
  function handleStrategyChange(id: string) {
    setSelectedStrategy(id)
    const strat = strategies.find((s) => s.id === id)
    if (strat?.paramsFields) {
      setFieldValues(defaultFieldValues(strat.paramsFields))
    } else {
      setFieldValues({})
      setBaseParams('{}')
      setTunableParams('{}')
    }
  }

  function validateJson(value: string, setter: (e: string) => void): boolean {
    try {
      JSON.parse(value)
      setter('')
      return true
    } catch {
      setter('Invalid JSON')
      return false
    }
  }

  function buildParams(): { base: Record<string, unknown>; tunable: Record<string, unknown> } | null {
    const strategy = strategies.find((s) => s.id === selectedStrategy)
    if (strategy?.paramsFields) {
      return buildParamsFromFields(strategy.paramsFields, fieldValues)
    }
    const baseOk = validateJson(baseParams, setBaseError)
    const tunableOk = validateJson(tunableParams, setTunableError)
    if (!baseOk || !tunableOk) return null
    return {
      base: JSON.parse(baseParams) as Record<string, unknown>,
      tunable: JSON.parse(tunableParams) as Record<string, unknown>,
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError('')
    const params = buildParams()
    if (!params) return

    setSubmitting(true)
    const now = new Date().toISOString()
    const payload: StrategyInstance = {
      id: newId('inst'),
      name: name.trim(),
      description: description.trim() || undefined,
      strategyId: selectedStrategy,
      accounts: selectedAccounts,
      params,
      enabled,
      createdAt: now,
      updatedAt: now,
    }

    const res = await fetch('/api/instances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (res.ok) {
      onSuccess()
    } else {
      const body = await res.text()
      setSubmitError(body || 'Failed to activate instance')
    }
    setSubmitting(false)
  }

  const strategy = strategies.find((s) => s.id === selectedStrategy)

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg p-5 mb-2 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <h2 className="font-semibold text-base">New Strategy Instance</h2>

      {/* Strategy selector */}
      <FormField label="Strategy" required>
        {strategies.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No strategies registered.</p>
        ) : (
          <select
            value={selectedStrategy}
            onChange={(e) => handleStrategyChange(e.target.value)}
            required
            className="rounded-md px-3 py-2 text-sm w-full"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}{s.description ? ` — ${s.description}` : ''}
              </option>
            ))}
          </select>
        )}
        {strategy && (
          <div className="flex flex-wrap gap-2 mt-1">
            {strategy.monitorIds.length > 0 && <Tag label="Monitors" values={strategy.monitorIds} color="var(--accent)" />}
            {strategy.executorIds.length > 0 && <Tag label="Executors" values={strategy.executorIds} color="var(--warning)" />}
          </div>
        )}
      </FormField>

      {/* Name */}
      <FormField label="Name" required>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="e.g. Copy Trade BTC Leader"
          className="rounded-md px-3 py-2 text-sm w-full"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        />
      </FormField>

      {/* Description */}
      <FormField label="Description">
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          className="rounded-md px-3 py-2 text-sm w-full"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        />
      </FormField>

      {/* Accounts */}
      <FormField label="Accounts" hint="Select credentials in the order the strategy declares accountTypes">
        {credentials.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--muted)' }}>No credentials stored. Add credentials first.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {credentials.map((cred) => {
              const checked = selectedAccounts.includes(cred.name)
              const idx = selectedAccounts.indexOf(cred.name)
              return (
                <label
                  key={cred.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer"
                  style={{
                    background: checked ? '#1e3a5f' : 'var(--background)',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setSelectedAccounts((prev) =>
                      checked ? prev.filter((n) => n !== cred.name) : [...prev, cred.name]
                    )}
                    className="accent-blue-500"
                  />
                  <span className="text-sm flex-1">{cred.name}</span>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>{cred.type}</span>
                  {checked && (
                    <span className="text-xs px-1.5 py-0.5 rounded" style={{ background: 'var(--accent)', color: '#fff' }}>
                      #{idx + 1}
                    </span>
                  )}
                </label>
              )
            })}
          </div>
        )}
      </FormField>

      {/* Params — generic field renderer if paramsFields present, JSON editor otherwise */}
      {strategy?.paramsFields ? (
        <ParamFieldsForm
          fields={strategy.paramsFields}
          values={fieldValues}
          onChange={setFieldValues}
        />
      ) : (
        <>
          <FormField label="Base Params (JSON)" hint="Required params defined in baseParamsSchema" error={baseError}>
            <JsonEditor
              value={baseParams}
              onChange={(v) => { setBaseParams(v); validateJson(v, setBaseError) }}
              placeholder='{ "symbol": "BTC" }'
              hasError={!!baseError}
            />
          </FormField>
          <FormField label="Tunable Params (JSON)" hint="Optional — Zod defaults apply for missing fields" error={tunableError}>
            <JsonEditor
              value={tunableParams}
              onChange={(v) => { setTunableParams(v); validateJson(v, setTunableError) }}
              placeholder='{ "threshold": 100000 }'
              hasError={!!tunableError}
            />
          </FormField>
        </>
      )}

      {/* Enabled toggle */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          className="relative w-10 h-5 rounded-full transition-colors"
          style={{ background: enabled ? 'var(--accent)' : 'var(--border)' }}
          aria-label="Toggle enabled"
        >
          <span
            className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
            style={{ transform: enabled ? 'translateX(1.25rem)' : 'translateX(0.125rem)' }}
          />
        </button>
        <span className="text-sm">{enabled ? 'Enabled' : 'Disabled'}</span>
      </div>

      {submitError && (
        <p className="text-sm px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>
          {submitError}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || strategies.length === 0}
          className="px-4 py-2 rounded-md text-sm"
          style={{ background: 'var(--accent)', color: '#fff', opacity: submitting ? 0.6 : 1 }}
        >
          {submitting ? 'Activating…' : 'Activate'}
        </button>
      </div>
    </form>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function FormField({
  label, hint, error, required, children,
}: {
  label: string; hint?: string; error?: string; required?: boolean; children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
          {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
        </label>
        {hint && <span className="text-xs" style={{ color: 'var(--muted)', opacity: 0.6 }}>— {hint}</span>}
      </div>
      {children}
      {error && <span className="text-xs" style={{ color: 'var(--danger)' }}>{error}</span>}
    </div>
  )
}

function JsonEditor({ value, onChange, placeholder, hasError }: {
  value: string; onChange: (v: string) => void; placeholder?: string; hasError: boolean
}) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      rows={3}
      placeholder={placeholder}
      spellCheck={false}
      className="rounded-md px-3 py-2 text-sm font-mono resize-y w-full"
      style={{
        background: 'var(--background)',
        color: 'var(--foreground)',
        border: `1px solid ${hasError ? 'var(--danger)' : 'var(--border)'}`,
      }}
    />
  )
}

function Tag({ label, values, color }: { label: string; values: string[]; color: string }) {
  return (
    <span className="text-xs flex items-center gap-1" style={{ color: 'var(--muted)' }}>
      {label}:
      {values.map((v) => (
        <span key={v} className="px-1.5 py-0.5 rounded" style={{ background: color + '22', color }}>
          {v}
        </span>
      ))}
    </span>
  )
}

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <div
      className="rounded-lg p-10 text-center flex flex-col items-center gap-3"
      style={{ background: 'var(--surface)', border: '1px dashed var(--border)' }}
    >
      <p className="text-sm" style={{ color: 'var(--muted)' }}>No active instances yet.</p>
      <button
        onClick={onNew}
        className="px-4 py-2 rounded-md text-sm"
        style={{ background: 'var(--accent)', color: '#fff' }}
      >
        + Activate your first strategy
      </button>
    </div>
  )
}

// ── Instance card ─────────────────────────────────────────────────────────────

function InstanceCard({ instance, onDeactivate }: { instance: StrategyInstance; onDeactivate: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const base = instance.params?.base ?? {}

  return (
    <div
      className="rounded-lg overflow-hidden"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      {/* Header row */}
      <div className="p-4 flex items-start justify-between gap-4">
        <button
          className="flex flex-col gap-1 min-w-0 text-left flex-1"
          onClick={() => setExpanded((v) => !v)}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium truncate">{instance.name}</span>
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{
                background: instance.enabled ? '#14532d' : '#3f1f1f',
                color: instance.enabled ? 'var(--success)' : 'var(--danger)',
              }}
            >
              {instance.enabled ? 'enabled' : 'disabled'}
            </span>
            <span className="text-xs ml-auto" style={{ color: 'var(--muted)' }}>
              {expanded ? '▲' : '▼'}
            </span>
          </div>
          {instance.description && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>{instance.description}</span>
          )}
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            strategy: <span style={{ color: 'var(--accent)' }}>{instance.strategyId}</span>
            {' · '}id: {instance.id}
          </span>
          {instance.accounts && instance.accounts.length > 0 && (
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              accounts: {instance.accounts.join(', ')}
            </span>
          )}
          {instance.strategyId === 'hl-copy-trading' && base.targetAddress ? (
            <div className="flex flex-wrap gap-3 mt-1">
              <ParamBadge label="target" value={String(base.targetAddress).slice(0, 10) + '…'} />
              <ParamBadge label="ratio" value={`${Number(base.ratio) * 100}%`} />
              <ParamBadge label="max" value={`$${base.maxPositionUsd}`} />
            </div>
          ) : Object.keys(base).length > 0 ? (
            <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>
              base: {JSON.stringify(base)}
            </span>
          ) : null}
        </button>

        <div className="shrink-0 flex gap-2">
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
                onClick={onDeactivate}
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
              Deactivate
            </button>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {expanded && <InstanceDetail instanceId={instance.id} />}
    </div>
  )
}

// ── Instance detail panel ─────────────────────────────────────────────────────

function InstanceDetail({ instanceId }: { instanceId: string }) {
  const [liveEvents, setLiveEvents] = useState<LiveEvent[]>([])
  const [executions, setExecutions] = useState<ExecutionResult[]>([])
  const [activeTab, setActiveTab] = useState<'events' | 'executions'>('events')
  const eventsEndRef = useRef<HTMLDivElement>(null)

  // SSE — filter events for this instance
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const event = JSON.parse(e.data) as LiveEvent
        if (event.type === 'strategy_run' && event.instanceId !== instanceId) return
        setLiveEvents((prev) => [event, ...prev].slice(0, 100))
      } catch { /* ignore */ }
    }
    return () => es.close()
  }, [instanceId])

  // Auto-scroll events list
  useEffect(() => {
    eventsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveEvents])

  // Poll executions every 5 s
  const fetchExecutions = useCallback(async () => {
    const res = await fetch(`/api/instances/${instanceId}/executions`)
    if (res.ok) setExecutions(await res.json() as ExecutionResult[])
  }, [instanceId])

  useEffect(() => {
    void fetchExecutions()
    const t = setInterval(() => void fetchExecutions(), 5000)
    return () => clearInterval(t)
  }, [fetchExecutions])

  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      {/* Tabs */}
      <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
        {(['events', 'executions'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="px-4 py-2 text-xs capitalize"
            style={{
              background: activeTab === tab ? 'var(--background)' : 'transparent',
              color: activeTab === tab ? 'var(--foreground)' : 'var(--muted)',
              borderBottom: activeTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {tab === 'events' ? `Live Events (${liveEvents.length})` : `Executions (${executions.length})`}
          </button>
        ))}
      </div>

      <div className="p-3 max-h-72 overflow-y-auto font-mono text-xs flex flex-col gap-1.5" style={{ background: 'var(--background)' }}>
        {activeTab === 'events' ? (
          liveEvents.length === 0 ? (
            <span style={{ color: 'var(--muted)' }}>Waiting for events…</span>
          ) : (
            liveEvents.map((ev, i) => <EventRow key={i} event={ev} />)
          )
        ) : (
          executions.length === 0 ? (
            <span style={{ color: 'var(--muted)' }}>No executions recorded today.</span>
          ) : (
            executions.map((ex, i) => <ExecutionRow key={i} result={ex} />)
          )
        )}
        <div ref={eventsEndRef} />
      </div>
    </div>
  )
}

function EventRow({ event }: { event: LiveEvent }) {
  const time = new Date(event.type === 'monitor_emit' ? event.ts : event.timestamp).toLocaleTimeString()

  if (event.type === 'monitor_emit') {
    return (
      <div className="flex gap-2 items-start">
        <span style={{ color: 'var(--muted)' }}>{time}</span>
        <span className="px-1 rounded text-xs" style={{ background: 'var(--accent)22', color: 'var(--accent)' }}>monitor</span>
        <span style={{ color: 'var(--muted)' }}>{event.monitor}</span>
        <span style={{ color: 'var(--foreground)' }}>key={event.key}</span>
        <span className="truncate" style={{ color: 'var(--muted)' }}>{JSON.stringify(event.data).slice(0, 80)}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex gap-2 items-start">
        <span style={{ color: 'var(--muted)' }}>{time}</span>
        <span className="px-1 rounded text-xs" style={{ background: 'var(--warning)22', color: 'var(--warning)' }}>strategy</span>
        <span style={{ color: 'var(--foreground)' }}>triggered</span>
        <span style={{ color: 'var(--muted)' }}>{event.triggerId}</span>
      </div>
      {event.instructions.length > 0 && (
        <div className="ml-16 flex flex-col gap-0.5">
          {event.instructions.map((ins, i) => (
            <div key={i} className="flex gap-2">
              <span className="px-1 rounded text-xs" style={{ background: 'var(--success)22', color: 'var(--success)' }}>→</span>
              <span style={{ color: 'var(--foreground)' }}>{ins.action}</span>
              <span style={{ color: 'var(--muted)' }}>via {ins.executorId}</span>
              <span className="truncate" style={{ color: 'var(--muted)' }}>{JSON.stringify(ins.params).slice(0, 60)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ExecutionRow({ result }: { result: ExecutionResult }) {
  const time = new Date(result.executedAt).toLocaleTimeString()
  const statusColor = result.status === 'success' ? 'var(--success)' : result.status === 'failed' ? 'var(--danger)' : 'var(--muted)'

  return (
    <div className="flex gap-2 items-start">
      <span style={{ color: 'var(--muted)' }}>{time}</span>
      <span className="px-1 rounded text-xs" style={{ background: statusColor + '22', color: statusColor }}>{result.status}</span>
      <span style={{ color: 'var(--foreground)' }}>{result.instruction.action}</span>
      <span style={{ color: 'var(--muted)' }}>via {result.instruction.executorId}</span>
      {result.error && <span style={{ color: 'var(--danger)' }}>{result.error}</span>}
      <span className="truncate" style={{ color: 'var(--muted)' }}>{JSON.stringify(result.instruction.params).slice(0, 60)}</span>
    </div>
  )
}

function ParamBadge({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-xs flex items-center gap-1" style={{ color: 'var(--muted)' }}>
      {label}:
      <span className="px-1.5 py-0.5 rounded font-mono" style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
        {value}
      </span>
    </span>
  )
}
