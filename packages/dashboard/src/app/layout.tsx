import type { Metadata } from 'next'
import './globals.css'
import { Nav } from '@/components/Nav'
import { Logo } from '@/components/Logo'

export const metadata: Metadata = {
  title: 'OpenWhale Dashboard',
  description: 'AI trading strategy engine dashboard',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
        <header className="flex items-center gap-3 px-6 py-3 border-b" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
          <span style={{ color: 'var(--accent)' }}><Logo size={24} /></span>
          <span className="text-sm font-semibold tracking-wide" style={{ color: 'var(--foreground)' }}>OpenWhale</span>
        </header>
        <div className="flex" style={{ minHeight: 'calc(100vh - 49px)' }}>
          <Nav />
          <main className="flex-1 p-6 overflow-auto">{children}</main>
        </div>
      </body>
    </html>
  )
}
