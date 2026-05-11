'use client'

import { useState } from 'react'
import type { CredentialInfo } from '@openwhale/core'

interface Props {
  initialCredentials: CredentialInfo[]
}

export function CredentialsClient({ initialCredentials }: Props) {
  const [credentials, setCredentials] = useState(initialCredentials)
  const [showForm, setShowForm] = useState(false)
  const [loading, setLoading] = useState(false)

  async function refresh() {
    const res = await fetch('/api/credentials')
    if (res.ok) setCredentials(await res.json())
  }

  async function deleteCredential(id: string) {
    await fetch(`/api/credentials/${id}`, { method: 'DELETE' })
    await refresh()
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    const form = e.currentTarget
    const fd = new FormData(form)
    const name = fd.get('name') as string
    const type = fd.get('type') as string
    const rawData = fd.get('data') as string

    let data: Record<string, unknown>
    try {
      data = JSON.parse(rawData) as Record<string, unknown>
    } catch {
      alert('Data must be valid JSON')
      setLoading(false)
      return
    }

    const res = await fetch('/api/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, data }),
    })

    if (res.ok) {
      form.reset()
      setShowForm(false)
      await refresh()
    }
    setLoading(false)
  }

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 rounded-md text-sm transition-colors"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          {showForm ? 'Cancel' : '+ Add Credential'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="rounded-lg p-4 mb-4 flex flex-col gap-3"
          style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
        >
          <h2 className="font-medium">New Credential</h2>
          <Field label="Name" name="name" placeholder="e.g. HL Main" required />
          <Field label="Type" name="type" placeholder="e.g. hyperliquid" required />
          <div className="flex flex-col gap-1">
            <label className="text-xs" style={{ color: 'var(--muted)' }}>
              Data (JSON)
            </label>
            <textarea
              name="data"
              rows={4}
              required
              placeholder='{"apiKey": "...", "secret": "..."}'
              className="rounded-md px-3 py-2 text-sm font-mono resize-y"
              style={{
                background: 'var(--background)',
                color: 'var(--foreground)',
                border: '1px solid var(--border)',
              }}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="self-end px-4 py-2 rounded-md text-sm"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            {loading ? 'Saving…' : 'Save'}
          </button>
        </form>
      )}

      {credentials.length === 0 ? (
        <div
          className="rounded-lg p-8 text-center text-sm"
          style={{ background: 'var(--surface)', color: 'var(--muted)', border: '1px solid var(--border)' }}
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

function Field({
  label,
  name,
  placeholder,
  required,
}: {
  label: string
  name: string
  placeholder?: string
  required?: boolean
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs" style={{ color: 'var(--muted)' }}>
        {label}
      </label>
      <input
        name={name}
        placeholder={placeholder}
        required={required}
        className="rounded-md px-3 py-2 text-sm"
        style={{
          background: 'var(--background)',
          color: 'var(--foreground)',
          border: '1px solid var(--border)',
        }}
      />
    </div>
  )
}

function CredentialCard({
  credential,
  onDelete,
}: {
  credential: CredentialInfo
  onDelete: () => void
}) {
  return (
    <div
      className="rounded-lg p-4 flex items-center justify-between gap-4"
      style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
    >
      <div className="flex flex-col gap-1">
        <span className="font-medium">{credential.name}</span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          type: {credential.type} · id: {credential.id}
        </span>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>
          created {new Date(credential.createdAt).toLocaleString()}
        </span>
      </div>
      <button
        onClick={onDelete}
        className="shrink-0 px-3 py-1.5 rounded-md text-xs"
        style={{ background: '#3f1f1f', color: 'var(--danger)', border: '1px solid #7f1d1d' }}
      >
        Delete
      </button>
    </div>
  )
}
