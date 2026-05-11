'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const links = [
  { href: '/instances', label: 'Instances' },
  { href: '/credentials', label: 'Credentials' },
  { href: '/monitor', label: 'Monitor' },
]

export function Nav() {
  const pathname = usePathname()

  return (
    <nav
      className="w-52 shrink-0 flex flex-col gap-1 p-4 border-r"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="mb-6 px-2">
        <span className="text-lg font-bold tracking-tight" style={{ color: 'var(--accent)' }}>
          OpenWhale
        </span>
      </div>
      {links.map(({ href, label }) => {
        const active = pathname.startsWith(href)
        return (
          <Link
            key={href}
            href={href}
            className="px-3 py-2 rounded-md text-sm transition-colors"
            style={{
              background: active ? 'var(--accent)' : 'transparent',
              color: active ? '#fff' : 'var(--muted)',
            }}
          >
            {label}
          </Link>
        )
      })}
    </nav>
  )
}
