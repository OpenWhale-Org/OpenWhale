'use client'

import { useState, useEffect, useCallback } from 'react'
import type { StrategyInstance } from '@openwhale/core'
import type { StrategyDefinition, CredentialInfo } from '@openwhale/core'

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
}

interface Props {
  initialInstances: StrategyInstance[]
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
      if (s.length > 0) setSelectedStrategy(s[0]!.id)
    })
  }, [])

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitError('')
    const baseOk = validateJson(baseParams, setBaseError)
    const tunableOk = validateJson(tunableParams, setTunableError)
    if (!baseOk || !tunableOk) return

    setSubmitting(true)
    const now = new Date().toISOString()
    const payload: StrategyInstance = {
      id: newId('inst'),
      name: name.trim(),
      description: description.trim() || undefined,
      strategyId: selectedStrategy,
      accounts: selectedAccounts,
      params: {
        base: JSON.parse(baseParams) as Record<string, unknown>,
        tunable: JSON.parse(tunableParams) as Record<string, unknown>,
      },
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
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No strategies registered. Register a strategy in code first.
          </p>
        ) : (
          <select
            value={selectedStrategy}
            onChange={(e) => setSelectedStrategy(e.target.value)}
            required
            className="rounded-md px-3 py-2 text-sm w-full"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name || s.id}
                {s.description ? ` — ${s.description}` : ''}
              </option>
            ))}
          </select>
        )}
        {strategy && (
          <div className="flex flex-wrap gap-2 mt-1">
            {strategy.monitorIds.length > 0 && (
              <Tag label="Monitors" values={strategy.monitorIds} color="var(--accent)" />
            )}
            {strategy.executorIds.length > 0 && (
              <Tag label="Executors" values={strategy.executorIds} color="var(--warning)" />
            )}
          </div>
        )}
      </FormField>

      {/* Name */}
      <FormField label="Name" required>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="e.g. BTC Breakout Strategy"
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
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            No credentials stored. Add credentials first.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {credentials.map((cred) => {
              const checked = selectedAccounts.includes(cred.name)
              const idx = selectedAccounts.indexOf(cred.name)
              return (
                <label
                  key={cred.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer transition-colors"
                  style={{
                    background: checked ? '#1e3a5f' : 'var(--background)',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setSelectedAccounts((prev) =>
                        checked ? prev.filter((n) => n !== cred.name) : [...prev, cred.name],
                      )
                    }}
                    className="accent-blue-500"
                  />
                  <span className="text-sm flex-1">{cred.name}</span>
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    {cred.type}
                  </span>
                  {checked && (
                    <span
                      className="text-xs px-1.5 py-0.5 rounded"
                      style={{ background: 'var(--accent)', color: '#fff' }}
                    >
                      #{idx + 1}
                    </span>
                  )}
                </label>
              )
            })}
          </div>
        )}
      </FormField>

      {/* Base params */}
      <FormField label="Base Params (JSON)" hint="Required params defined in baseParamsSchema" error={baseError}>
        <JsonEditor
          value={baseParams}
          onChange={(v) => { setBaseParams(v); validateJson(v, setBaseError) }}
          placeholder='{ "symbol": "BTC" }'
          hasError={!!baseError}
        />
      </FormField>

      {/* Tunable params */}
      <FormField label="Tunable Params (JSON)" hint="Optional — Zod defaults apply for missing fields" error={tunableError}>
        <JsonEditor
          value={tunableParams}
          onChange={(v) => { setTunableParams(v); validateJson(v, setTunableError) }}
          placeholder='{ "threshold": 100000 }'
          hasError={!!tunableError}
        />
      </FormField>

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
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string
  hint?: string
  error?: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>
          {label}
          {required && <span style={{ color: 'var(--danger)' }}> *</span>}
        </label>
        {hint && (
          <span className="text-xs" style={{ color: 'var(--muted)', opacity: 0.6 }}>
            — {hint}
          </span>
        )}
      </div>
      {children}
      {error && (
        <span className="text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </span>
      )}
    </div>
  )
}

function JsonEditor({
  value,
  onChange,
  placeholder,
  hasError,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hasError: boolean
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
      <p className="text-sm" style={{ color: 'var(--muted)' }}>
        No active instances yet.
      </p>
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

function InstanceCard({
  instance,
  onDeactivate,
}: {
  instance: StrategyInstance
  onDeactivate: () => void
}) {
  const [confirming, setConfirming] = useState(false)

  return (
    <div
      className="rounded-lg p-4 flex items-start justify-between gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex flex-col gap-1 min-w-0">
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
        </div>
        {instance.description && (
          <span className="text-xs" style={{ color: 'var(--muted)' }}>
            {instance.description}
          </span>
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
        {instance.params?.base && Object.keys(instance.params.base).length > 0 && (
          <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>
            base: {JSON.stringify(instance.params.base)}
          </span>
        )}
      </div>

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
            className="px-3 py-1.5 rounded-md text-xs transition-colors"
            style={{ background: '#3f1f1f', color: 'var(--danger)', border: '1px solid #7f1d1d' }}
          >
            Deactivate
          </button>
        )}
      </div>
    </div>
  )
}
