'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { AuroraBackground } from '@/components/AuroraBackground'
import { AuroraLogo } from '@/components/AuroraLogo'
import { AuroraParticleCopy } from '@/components/AuroraParticleCopy'
import { Logo } from '@/components/Logo'
import { useT } from '@/i18n'

export default function LoginPage() {
  const t = useT()
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
      setError(err instanceof Error ? err.message : t('login.unreachable'))
    } finally {
      setBusy(false)
    }
  }

  const configWarning = configured === false && (
    <p className="aurora-login-warning">
      {t('login.notConfigured').split(/(`[^`]+`)/g).filter(Boolean).map((part, i) =>
        part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : <span key={i}>{part}</span>)}
    </p>
  )


  return (
    <div className="aurora-login-page">
      <section className="aurora-login-brand">
        <AuroraBackground />
        <div className="aurora-login-brand-content">
          <AuroraLogo size="lg" particle />
          <AuroraParticleCopy />
          <div className="aurora-login-signal"><i /> {t('login.signal')}</div>
        </div>
      </section>

      <section className="aurora-login-panel">
        <div className="aurora-login-panel-glow" />
        <form onSubmit={submit} className="aurora-login-form">
          <div className="aurora-login-form-heading">
            <span className="aurora-login-eyebrow">{t('login.eyebrow')}</span>
            <h2>{t('login.welcome')}</h2>
            <p>{t('login.subtitle')}</p>
          </div>
          {configWarning}
          <label className="aurora-field">
            <span>{t('login.username')}</span>
            <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required autoFocus placeholder={t('login.usernamePlaceholder')} />
          </label>
          <label className="aurora-field">
            <span>{t('login.password')}</span>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required placeholder={t('login.passwordPlaceholder')} />
          </label>
          {error && <p className="aurora-login-error">{error}</p>}
          <button type="submit" disabled={busy} className="aurora-login-submit">
            <span>{busy ? t('login.signingIn') : t('login.signIn')}</span>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
          <div className="aurora-login-meta">
            <span><i /> {t('login.secure')}</span>
          </div>
        </form>
      </section>
    </div>
  )
}
