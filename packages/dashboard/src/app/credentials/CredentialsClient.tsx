'use client'

import { useState } from 'react'
import type { CredentialInfo } from '@openwhale/core'

interface Props {
  initialCredentials: CredentialInfo[]
}

// ── Typed credential forms ────────────────────────────────────────────────────

function HyperliquidCredentialForm({
  onSubmit,
  loading,
}: {
  onSubmit: (name: string, data: Record<string, unknown>) => Promise<void>
  loading: boolean
}) {
  const [name, setName] = useState('')
  const [walletAddress, setWalletAddress] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!walletAddress.match(/^0x[0-9a-fA-F]{40}$/)) {
      setError('Wallet address must be a valid EVM address (0x...)')
      return
    }
    if (privateKey && !privateKey.match(/^0x[0-9a-fA-F]{64}$/)) {
      setError('Private key must be 0x followed by 64 hex characters')
      return
    }
    const data: Record<string, unknown> = { walletAddress }
    if (privateKey) data.privateKey = privateKey
    await onSubmit(name, data)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <InputField label="Name" value={name} onChange={setName} placeholder="e.g. HL Main" required />
      <InputField
        label="Wallet Address"
        value={walletAddress}
        onChange={setWalletAddress}
        placeholder="0x..."
        required
        mono
      />
      <InputField
        label="Private Key"
        value={privateKey}
        onChange={setPrivateKey}
        placeholder="0x... (leave empty for read-only)"
        type="password"
        mono
      />
      {error && <p className="text-xs px-3 py-2 rounded-md" style={{ background: '#3f1f1f', color: 'var(--danger)' }}>{error}</p>}
      <button
        type="submit"
        disabled={loading || !name || !walletAddress}
        className="self-end px-4 py-2 rounded-md text-sm"
        style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? 0.6 : 1 }}
      >
        {loading ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}

function GenericCredentialForm({
  onSubmit,
  loading,
}: {
  onSubmit: (name: string, data: Record<string, unknown>) => Promise<void>
  loading: boolean
}) {
  const [name, setName] = useState('')
  const [rawData, setRawData] = useState('{}')
  const [jsonError, setJsonError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    let data: Record<string, unknown>
    try {
      data = JSON.parse(rawData) as Record<string, unknown>
    } catch {
      setJsonError('Invalid JSON')
      return
    }
    await onSubmit(name, data)
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <InputField label="Name" value={name} onChange={setName} placeholder="e.g. My Account" required />
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
        disabled={loading || !name}
        className="self-end px-4 py-2 rounded-md text-sm"
        style={{ background: 'var(--accent)', color: '#fff', opacity: loading ? 0.6 : 1 }}
      >
        {loading ? 'Saving…' : 'Save'}
      </button>
    </form>
  )
}

// ── Credential type selector ──────────────────────────────────────────────────

const CREDENTIAL_TYPES = [
  { id: 'hyperliquid', label: 'Hyperliquid' },
  { id: 'other', label: 'Other' },
]

function AddCredentialForm({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [type, setType] = useState('hyperliquid')
  const [loading, setLoading] = useState(false)

  async function submit(name: string, data: Record<string, unknown>) {
    setLoading(true)
    const res = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, data }),
    })
    setLoading(false)
    if (res.ok) onSuccess()
  }

  return (
    <div
      className="rounded-lg p-5 mb-4 flex flex-col gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <h2 className="font-semibold text-base">Add Credential</h2>

      {/* Type selector */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--muted)' }}>Type</label>
        <div className="flex gap-2">
          {CREDENTIAL_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setType(t.id)}
              className="px-3 py-1.5 rounded-md text-sm transition-colors"
              style={{
                background: type === t.id ? 'var(--accent)' : 'var(--background)',
                color: type === t.id ? '#fff' : 'var(--muted)',
                border: `1px solid ${type === t.id ? 'var(--accent)' : 'var(--border)'}`,
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {type === 'hyperliquid' ? (
        <HyperliquidCredentialForm onSubmit={submit} loading={loading} />
      ) : (
        <GenericCredentialForm onSubmit={submit} loading={loading} />
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

export function CredentialsClient({ initialCredentials }: Props) {
  const [credentials, setCredentials] = useState(initialCredentials)
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)

  async function refresh() {
    setLoading(true)
    const res = await fetch('/api/credentials')
    if (res.ok) setCredentials(await res.json())
    setLoading(false)
  }

  async function deleteCredential(id: string) {
    await fetch(`/api/credentials/${id}`, { method: 'DELETE' })
    await refresh()
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
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
          {credentials.map((cred) => (
            <CredentialCard key={cred.id} credential={cred} onDelete={() => deleteCredential(cred.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

// ── Credential card ───────────────────────────────────────────────────────────

function CredentialCard({ credential, onDelete }: { credential: CredentialInfo; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false)

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
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          created {new Date(credential.createdAt).toLocaleString()}
        </span>
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

// ── Shared input ──────────────────────────────────────────────────────────────

function InputField({
  label,
  value,
  onChange,
  placeholder,
  required,
  type = 'text',
  mono,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  required?: boolean
  type?: string
  mono?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs" style={{ color: 'var(--muted)' }}>
        {label}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
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
