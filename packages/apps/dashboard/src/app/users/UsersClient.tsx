'use client'

import { useState } from 'react'
import type { AuthUser } from '@/lib/auth'

/**
 * Account management. Every user here can do everything — there are no roles,
 * because anyone who can reach this gateway can already move real money, and a
 * read-only tier that still exposes credential names would be security
 * theatre. Add accounts for people you would hand the API keys to.
 */
export function UsersClient({ initialUsers, currentUserId }: { initialUsers: AuthUser[]; currentUserId?: string }) {
  const [users, setUsers] = useState(initialUsers)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [resetFor, setResetFor] = useState<string | null>(null)
  const [newPassword, setNewPassword] = useState('')

  async function refresh() {
    const res = await fetch('/api/users')
    if (res.ok) setUsers(await res.json() as AuthUser[])
  }

  async function call(path: string, init: RequestInit): Promise<boolean> {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(path, init)
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? `HTTP ${res.status}`)
        return false
      }
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function addUser(e: React.FormEvent) {
    e.preventDefault()
    const ok = await call('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    if (ok) { setUsername(''); setPassword(''); await refresh() }
  }

  async function resetPassword(id: string) {
    const ok = await call(`/api/users/${id}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: newPassword }),
    })
    if (!ok) return
    setResetFor(null)
    setNewPassword('')
    // A password change ends that user's sessions — including this one when
    // it is your own account.
    if (id === currentUserId) window.location.href = '/login'
  }

  async function remove(id: string) {
    if (await call(`/api/users/${id}`, { method: 'DELETE' })) await refresh()
  }

  return (
    <div className="flex flex-col gap-6" style={{ maxWidth: '46rem' }}>
      <div>
        <h1 className="text-lg font-semibold">Users</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>
          Everyone listed here has full control of the gateway: credentials, strategies and live orders.
          There are no read-only roles.
        </p>
      </div>

      {error && (
        <p className="text-xs rounded-md p-2" style={{ color: 'var(--danger)', background: 'var(--surface)' }}>{error}</p>
      )}

      <section className="rounded-lg" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        {users.map((u) => (
          <div key={u.id} className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="flex flex-col min-w-0 flex-1">
              <span className="text-sm">
                {u.username}
                {u.id === currentUserId && <span className="text-xs ml-2" style={{ color: 'var(--accent)' }}>you</span>}
              </span>
              <span className="text-xs" style={{ color: 'var(--muted)' }}>
                since {new Date(u.createdAt).toLocaleDateString()}
              </span>
            </div>
            {resetFor === u.id ? (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="new password"
                  className="rounded-md px-2 py-1 text-xs"
                  style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                />
                <button
                  onClick={() => void resetPassword(u.id)}
                  disabled={busy || newPassword.length < 8}
                  className="text-xs px-2 py-1 rounded-md"
                  style={{ background: 'var(--accent)', color: '#fff', opacity: busy || newPassword.length < 8 ? 0.5 : 1 }}
                >
                  save
                </button>
                <button
                  onClick={() => { setResetFor(null); setNewPassword('') }}
                  className="text-xs px-2 py-1 rounded-md"
                  style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                >
                  cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setResetFor(u.id)}
                  className="text-xs px-2 py-1 rounded-md"
                  style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                >
                  set password
                </button>
                <button
                  onClick={() => void remove(u.id)}
                  disabled={busy || users.length <= 1}
                  title={users.length <= 1 ? 'the last account cannot be removed' : undefined}
                  className="text-xs px-2 py-1 rounded-md"
                  style={{ border: '1px solid var(--border)', color: 'var(--danger)', opacity: users.length <= 1 ? 0.4 : 1 }}
                >
                  remove
                </button>
              </div>
            )}
          </div>
        ))}
      </section>

      <form onSubmit={addUser} className="rounded-lg p-4 flex flex-col gap-3" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
        <span className="text-xs font-semibold" style={{ color: 'var(--muted)' }}>ADD USER</span>
        <div className="flex gap-2 flex-wrap">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="username"
            required
            className="rounded-md px-3 py-2 text-sm flex-1"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="password (min 8)"
            required
            minLength={8}
            className="rounded-md px-3 py-2 text-sm flex-1"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md px-3 py-2 text-sm"
            style={{ background: 'var(--accent)', color: '#fff', opacity: busy ? 0.5 : 1 }}
          >
            Add
          </button>
        </div>
      </form>
    </div>
  )
}
