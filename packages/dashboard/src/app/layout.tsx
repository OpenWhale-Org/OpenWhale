import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import './globals.css'
import { Nav } from '@/components/Nav'
import { Logo } from '@/components/Logo'
import { UserMenu } from '@/components/UserMenu'
import { SESSION_COOKIE } from '@/lib/auth'
import { fetchCurrentUser } from '@/lib/data'

export const metadata: Metadata = {
  title: 'OpenWhale Dashboard',
  description: 'AI trading strategy engine dashboard',
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Signed-out pages (the login form) get the chrome without the nav — there is
  // nothing behind those links until there is a session.
  const store = await cookies()
  const signedIn = store.has(SESSION_COOKIE)
  const username = signedIn ? (await fetchCurrentUser()).user?.username : undefined

  return (
    <html lang="en">
      <body className="min-h-screen" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
        <header className="flex items-center gap-3 px-6 py-3 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <span style={{ color: 'var(--accent)' }}><Logo size={24} /></span>
          <span className="text-sm font-semibold tracking-wide" style={{ color: 'var(--foreground)' }}>OpenWhale</span>
          <UserMenu {...(username ? { username } : {})} />
        </header>
        <div className="flex" style={{ minHeight: 'calc(100vh - 49px)' }}>
          {signedIn && <Nav />}
          <main className="flex-1 p-6 overflow-auto">{children}</main>
        </div>
      </body>
    </html>
  )
}
