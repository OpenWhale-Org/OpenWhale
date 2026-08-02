'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Logo } from '@/components/Logo'

/**
 * Sign-in. The gateway owns the decision — this form only relays the answer,
 * and a wrong password gets the same message as an unknown user because the
 * backend deliberately does not distinguish them.
 */
export default function LoginPage() {
  const router = useRouter()
  const params = useSearchParams()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [configured, setConfigured] = useState<boolean | null>(null)

  useEffect(() => {
    void fetch('/api/auth/status')
      .then(r => r.json() as Promise<{ configured: boolean }>)
      .then(d => setConfigured(d.configured))
      .catch(() => setConfigured(null))
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        setError(body.error ?? `HTTP ${res.status}`)
        return
      }
      // Full navigation, not router.push: every server component must re-render
      // with the new cookie attached.
      window.location.href = params.get('next') || '/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'gateway unreachable')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-center" style={{ minHeight: '70vh' }}>
      <form
        onSubmit={submit}
        className="rounded-lg p-6 flex flex-col gap-4"
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', width: '22rem' }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--accent)' }}><Logo size={22} /></span>
          <span className="text-sm font-semibold">Sign in to OpenWhale</span>
        </div>

        {configured === false && (
          <p className="text-xs rounded-md p-2" style={{ color: 'var(--warning)', background: 'var(--background)' }}>
            No account exists yet. Set <code>OPENWHALE_ADMIN_USER</code> and{' '}
            <code>OPENWHALE_ADMIN_PASSWORD</code> in the repo-root <code>.env</code> and restart the gateway.
          </p>
        )}

        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            autoFocus
            className="rounded-md px-3 py-2 text-sm"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs" style={{ color: 'var(--muted)' }}>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            className="rounded-md px-3 py-2 text-sm"
            style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
          />
        </label>

        {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="rounded-md px-3 py-2 text-sm"
          style={{ background: 'var(--accent)', color: '#fff', opacity: busy ? 0.5 : 1 }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
