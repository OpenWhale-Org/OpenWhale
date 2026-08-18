'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AuroraBackground } from '@/components/AuroraBackground'
import { AuroraLogo } from '@/components/AuroraLogo'
import { AuroraParticleCopy } from '@/components/AuroraParticleCopy'
import { Logo } from '@/components/Logo'

export default function LoginPage() {
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
      window.location.href = params.get('next') || '/'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'gateway unreachable')
    } finally {
      setBusy(false)
    }
  }

  const configWarning = configured === false && (
    <p className="aurora-login-warning">
      No account exists yet. Set <code>OPENWHALE_ADMIN_USER</code> and{' '}
      <code>OPENWHALE_ADMIN_PASSWORD</code> in the repo-root <code>.env</code> and restart the gateway.
    </p>
  )


  return (
    <div className="aurora-login-page">
      <section className="aurora-login-brand">
        <AuroraBackground />
        <div className="aurora-login-brand-content">
          <AuroraLogo size="lg" />
          <AuroraParticleCopy />
          <div className="aurora-login-signal"><i /> Live market intelligence</div>
        </div>
      </section>

      <section className="aurora-login-panel">
        <div className="aurora-login-panel-glow" />
        <form onSubmit={submit} className="aurora-login-form">
          <div className="aurora-login-form-heading">
            <span className="aurora-login-eyebrow">OPENWHALE WORKSPACE</span>
            <h2>Welcome back</h2>
            <p>Sign in to continue to your trading workspace.</p>
          </div>
          {configWarning}
          <label className="aurora-field">
            <span>Username</span>
            <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required autoFocus placeholder="Enter your username" />
          </label>
          <label className="aurora-field">
            <span>Password</span>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required placeholder="Enter your password" />
          </label>
          {error && <p className="aurora-login-error">{error}</p>}
          <button type="submit" disabled={busy} className="aurora-login-submit">
            <span>{busy ? 'Signing in…' : 'Sign in'}</span>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
          <div className="aurora-login-meta">
            <span><i /> Secure gateway connection</span>
          </div>
        </form>
      </section>
    </div>
  )
}
