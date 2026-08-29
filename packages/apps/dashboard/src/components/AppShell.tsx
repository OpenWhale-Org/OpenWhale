'use client'

import { usePathname } from 'next/navigation'
import { Nav } from './Nav'
import { UserMenu } from './UserMenu'
import { Tour } from './Tour'

/**
 * The application shell.
 *
 * There used to be two of these — a "classic" shell and this one, chosen by a
 * cookie. Classic was retired on 2026-08-17: two shells meant every layout
 * change had to be made twice, and a fresh visitor (no cookie) landed on the
 * one nobody was maintaining.
 */

const routeLabels: Record<string, string> = {
  '/overview': 'Overview',
  '/instances': 'Strategies',
  '/accounts': 'Accounts',
  '/credentials': 'Credentials',
  '/monitor': 'Monitor',
  '/monitor-data': 'Explorer',
  '/executors': 'Executors',
  '/plugins': 'Plugins',
  '/compiler': 'Compiler',
  '/scripts': 'Scripts',
  '/assistant': 'Assistant',
  '/alerts': 'Alerts',
  '/users': 'Users',
}

function currentLabel(pathname: string): string {
  const key = Object.keys(routeLabels).find(path => pathname === path || pathname.startsWith(path + '/'))
  return key ? routeLabels[key]! : 'OpenWhale'
}

export function AppShell({ signedIn, username, children }: { signedIn: boolean; username?: string; children: React.ReactNode }) {
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
            <strong>{currentLabel(pathname)}</strong>
          </div>
          <UserMenu {...(username ? { username } : {})} />
        </header>
        <main className="aurora-main">{children}</main>
        <Tour />
      </div>
    </div>
  )
}
