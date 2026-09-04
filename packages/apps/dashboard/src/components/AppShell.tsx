'use client'

import { usePathname } from 'next/navigation'
import { Nav } from './Nav'
import { UserMenu } from './UserMenu'
import { Tour } from './Tour'
import { UnsavedGuard } from './unsaved'
import { useI18n, LOCALES, type MessageKey } from '@/i18n'

/**
 * The application shell.
 *
 * There used to be two of these — a "classic" shell and this one, chosen by a
 * cookie. Classic was retired on 2026-08-17: two shells meant every layout
 * change had to be made twice, and a fresh visitor (no cookie) landed on the
 * one nobody was maintaining.
 */

const routeLabels: Record<string, MessageKey> = {
  '/overview': 'nav.overview',
  '/instances': 'nav.instances.aurora',
  '/accounts': 'nav.accounts',
  '/credentials': 'nav.credentials',
  '/monitor': 'nav.monitor',
  '/monitor-data': 'nav.explorer',
  '/monitor-data/retention': 'nav.retention',
  '/executors': 'nav.executors',
  '/plugins': 'nav.plugins',
  '/compiler': 'nav.compiler',
  '/scripts': 'nav.scripts',
  '/assistant': 'nav.assistant',
  '/alerts': 'nav.alerts',
  '/users': 'nav.users',
}

function currentLabel(pathname: string, t: (k: MessageKey) => string): string {
  const key = Object.keys(routeLabels).find(path => pathname === path || pathname.startsWith(path + '/'))
  return key ? t(routeLabels[key]!) : 'OpenWhale'
}

export function AppShell({ signedIn, username, children }: { signedIn: boolean; username?: string; children: React.ReactNode }) {
  const { t, locale, setLocale } = useI18n()
  const pathname = usePathname()
  const login = pathname === '/login'

  if (login || !signedIn) return <div className="aurora-theme aurora-login-shell">{children}</div>

  return (
    <div className="aurora-theme aurora-app-shell">
      <Nav />
      <div className="aurora-workspace">
        <header className="aurora-topbar">
          <div className="aurora-topbar-context">
            <span className="aurora-live-dot" />
            <span>OpenWhale</span>
            <span className="aurora-topbar-separator">/</span>
            <strong>{currentLabel(pathname, t)}</strong>
          </div>
          <div className="aurora-topbar-right">
            <div className="aurora-lang" role="group" aria-label={t('nav.language')}>
              {LOCALES.map(l => (
                <button key={l.id} type="button" className={`aurora-lang-btn${locale === l.id ? ' is-active' : ''}`} onClick={() => { if (locale !== l.id) setLocale(l.id) }}>{l.label}</button>
              ))}
            </div>
            <UserMenu {...(username ? { username } : {})} />
          </div>
        </header>
        <main className="aurora-main">
          {/* The scroll container's own padding cannot be used: it would sit above
              every sticky header inside a page. See .aurora-main-inner. */}
          <div className="aurora-main-inner">{children}</div>
        </main>
        <Tour />
        <UnsavedGuard />
      </div>
    </div>
  )
}
