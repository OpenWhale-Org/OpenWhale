import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import './globals.css'
import { AppShell } from '@/components/AppShell'
import { parseUiMode, UI_MODE_COOKIE } from '@/lib/ui-mode'
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
  const initialMode = parseUiMode(store.get(UI_MODE_COOKIE)?.value)

  return (
    <html lang="en">
      <body className="min-h-screen" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
        <AppShell initialMode={initialMode} signedIn={signedIn} {...(username ? { username } : {})}>
          {children}
        </AppShell>
      </body>
    </html>
  )
}
