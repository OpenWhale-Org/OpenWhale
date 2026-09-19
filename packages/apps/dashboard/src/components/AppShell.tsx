'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { Nav } from './Nav'
import { UserMenu } from './UserMenu'
import { Tour } from './Tour'
import { UnsavedGuard } from './unsaved'
import { ExecutionToasts } from './ExecutionToasts'
import { TOPBAR_SLOT_ID } from './TopbarSlot'
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
  /*
   * On a phone the rail is off-screen and the same <Nav /> slides over the
   * page instead. One nav, two presentations — a second link list would be a
   * second thing to keep in step.
   */
  const [drawer, setDrawer] = useState(false)
  useEffect(() => { setDrawer(false) }, [pathname])
  useEffect(() => {
    if (!drawer) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawer(false) }
    window.addEventListener('keydown', onKey)
    // The page behind a covering drawer must not scroll under the finger.
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [drawer])

  if (login || !signedIn) return <div className="aurora-theme aurora-login-shell">{children}</div>

  return (
    <div className={`aurora-theme aurora-app-shell${drawer ? ' is-drawer-open' : ''}`}>
      <Nav onNavigate={() => setDrawer(false)} />
      {drawer && <button type="button" className="aurora-drawer-backdrop" aria-label={t('nav.closeMenu')} onClick={() => setDrawer(false)} />}
      <div className="aurora-workspace">
        <header className="aurora-topbar">
          <div className="aurora-topbar-context">
            <button
              type="button"
              className="aurora-menu-btn"
              aria-label={t(drawer ? 'nav.closeMenu' : 'nav.openMenu')}
              aria-expanded={drawer}
              onClick={() => setDrawer(v => !v)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                {drawer ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
            <span className="aurora-live-dot" />
            <span className="aurora-topbar-brand">OpenWhale</span>
            <span className="aurora-topbar-separator">/</span>
            <strong>{currentLabel(pathname, t)}</strong>
            {/* Pages push their own crumb here — see TopbarSlot. */}
            <span id={TOPBAR_SLOT_ID} className="aurora-topbar-slot" />
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
        <ExecutionToasts />
      </div>
    </div>
  )
}
