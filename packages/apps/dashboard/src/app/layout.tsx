import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import './globals.css'
import { AppShell } from '@/components/AppShell'
import { SESSION_COOKIE } from '@/lib/auth'
import { fetchCurrentUser } from '@/lib/data'
import { LocaleProvider, type Locale } from '@/i18n'
import { TimeZoneBoot } from '@/components/TimeZoneBoot'

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
  // The reader's language: the same cookie the gateway resolves plugin text with.
  const locale: Locale = (store.get('ow_locale')?.value ?? '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
  // The reader's clock, applied before anything renders so the server's UTC
  // and the browser agree on every timestamp in the first paint.
  const timeZone = store.get('ow_tz')?.value ?? ''

  return (
    <html lang={locale}>
      <body className="min-h-screen" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
        <TimeZoneBoot zone={timeZone} />
        <LocaleProvider locale={locale}>
          <AppShell signedIn={signedIn} {...(username ? { username } : {})}>
            {children}
          </AppShell>
        </LocaleProvider>
      </body>
    </html>
  )
}
