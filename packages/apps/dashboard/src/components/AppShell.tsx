'use client'

import { usePathname } from 'next/navigation'
import { Logo } from './Logo'
import { Nav } from './Nav'
import { UiModeProvider, useUiMode } from './UiModeProvider'
import type { UiMode } from '@/lib/ui-mode'
import { UserMenu } from './UserMenu'

const routeLabels: Record<string, string> = {
  '/overview': 'Overview',
  '/instances': 'Strategies',
  '/accounts': 'Accounts',
  '/credentials': 'Credentials',
  '/registry': 'Registry',
  '/monitor': 'Monitor',
  '/monitor-data': 'Explorer',
  '/executors': 'Executors',
  '/plugins': 'Plugins',
  '/compiler': 'Compiler',
  '/scripts': 'Scripts',
  '/assistant': 'Assistant',
  '/users': 'Users',
}

function currentLabel(pathname: string): string {
  const key = Object.keys(routeLabels).find(path => pathname === path || pathname.startsWith(path + '/'))
  return key ? routeLabels[key]! : 'OpenWhale'
}

function ShellContent({ signedIn, username, children }: { signedIn: boolean; username?: string; children: React.ReactNode }) {
  const { mode } = useUiMode()
  const pathname = usePathname()
  const login = pathname === '/login'

  if (mode === 'classic') {
    return (
      <div className="classic-shell min-h-screen">
        <header className="flex items-center gap-3 px-6 py-3 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <span style={{ color: 'var(--accent)' }}><Logo size={24} /></span>
          <span className="text-sm font-semibold tracking-wide" style={{ color: 'var(--foreground)' }}>OpenWhale</span>
          <UserMenu {...(username ? { username } : {})} />
        </header>
        <div className="flex" style={{ minHeight: 'calc(100vh - 49px)' }}>
          {signedIn && <Nav />}
          <main className="flex-1 p-6 overflow-auto">{children}</main>
        </div>
      </div>
    )
  }

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
      </div>
    </div>
  )
}

export function AppShell({ initialMode, signedIn, username, children }: { initialMode: UiMode; signedIn: boolean; username?: string; children: React.ReactNode }) {
  return (
    <UiModeProvider initialMode={initialMode}>
      <ShellContent signedIn={signedIn} username={username}>{children}</ShellContent>
    </UiModeProvider>
  )
}
