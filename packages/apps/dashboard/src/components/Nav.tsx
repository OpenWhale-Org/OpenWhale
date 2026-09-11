'use client'

import Link from 'next/link'
import { useI18n, type MessageKey } from '@/i18n'
import { usePathname } from 'next/navigation'
import { AuroraLogo } from './AuroraLogo'

type IconName = 'start' | 'overview' | 'strategies' | 'accounts' | 'credentials' | 'registry' | 'monitor' | 'explorer' | 'executors' | 'plugins' | 'compiler' | 'scripts' | 'assistant' | 'users' | 'alerts' | 'executions' | 'runs' | 'retention' | 'system'

const links: Array<{ href: string; label: MessageKey; auroraLabel?: MessageKey; group?: MessageKey; icon: IconName }> = [
  { href: '/instances', label: 'nav.instances', auroraLabel: 'nav.instances.aurora', group: 'nav.group.trade', icon: 'strategies' },
  { href: '/runs', label: 'nav.runs', group: 'nav.group.trade', icon: 'runs' },
  { href: '/accounts', label: 'nav.accounts', group: 'nav.group.trade', icon: 'accounts' },
  { href: '/credentials', label: 'nav.credentials', group: 'nav.group.settings', icon: 'credentials' },
  { href: '/monitor', label: 'nav.monitor', group: 'nav.group.observe', icon: 'monitor' },
  { href: '/monitor-data', label: 'nav.explorer', group: 'nav.group.observe', icon: 'explorer' },
  { href: '/monitor-data/retention', label: 'nav.retention', group: 'nav.group.observe', icon: 'retention' },
  { href: '/executors', label: 'nav.executors', group: 'nav.group.automate', icon: 'executors' },
  { href: '/executions', label: 'nav.executions', group: 'nav.group.automate', icon: 'executions' },
  { href: '/plugins', label: 'nav.plugins', group: 'nav.group.develop', icon: 'plugins' },
  { href: '/compiler', label: 'nav.compiler', group: 'nav.group.develop', icon: 'compiler' },
  { href: '/scripts', label: 'nav.scripts', group: 'nav.group.automate', icon: 'scripts' },
  { href: '/assistant', label: 'nav.assistant', icon: 'assistant' },
  { href: '/alerts', label: 'nav.alerts', group: 'nav.group.settings', icon: 'alerts' },
  { href: '/users', label: 'nav.users', group: 'nav.group.settings', icon: 'users' },
  { href: '/system', label: 'nav.system', group: 'nav.group.settings', icon: 'system' },
]

const auroraGroups: MessageKey[] = ['nav.group.trade', 'nav.group.observe', 'nav.group.automate', 'nav.group.develop', 'nav.group.settings']

function Icon({ name }: { name: IconName }) {
  const common = { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  switch (name) {
    case 'start': return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4Z" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2" /></svg>
    case 'overview': return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></svg>
    // A receipt: what was actually sent, one line per instruction.
    // A decision trail: a run is a list of steps, one of them marked.
    case 'runs': return <svg {...common}><path d="M4 6h10M4 12h16M4 18h7" /><circle cx="18" cy="6" r="2" /></svg>
    case 'executions': return <svg {...common}><path d="M6 3h9l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>
    case 'strategies': return <svg {...common}><path d="M4 18 9 12l4 3 7-9" /><path d="M15 6h5v5" /></svg>
    case 'accounts': return <svg {...common}><path d="M3 7h18v12H3z" /><path d="M16 12h5v3h-5a1.5 1.5 0 0 1 0-3Z" /><path d="M6 7V5h12v2" /></svg>
    case 'credentials': return <svg {...common}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l2 2M14 9l2 2" /></svg>
    case 'registry': return <svg {...common}><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" /></svg>
    case 'monitor': return <svg {...common}><path d="M3 12h4l2.5-7 5 14 2.5-7h4" /></svg>
    case 'explorer': return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5M11 8v6M8 11h6" /></svg>
    case 'executors': return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m10 8 6 4-6 4Z" /></svg>
    case 'plugins': return <svg {...common}><path d="M8 3h8v5h5v8h-5v5H8v-5H3V8h5Z" /><path d="M12 3v5M21 12h-5M12 21v-5M3 12h5" /></svg>
    case 'compiler': return <svg {...common}><path d="m8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18" /></svg>
    case 'scripts': return <svg {...common}><path d="m4 7 5 5-5 5M12 18h8" /></svg>
    case 'assistant': return <svg {...common}><path d="M12 3 13.5 8.5 19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5Z" /><path d="M19 17l.7 2.3L22 20l-2.3.7L19 23l-.7-2.3L16 20l2.3-.7Z" /></svg>
    case 'alerts': return <svg {...common}><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
    case 'retention': return <svg {...common}><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" /><path d="M12 11v3l2 1" /></svg>
    case 'system': return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>
    case 'users': return <svg {...common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.2a4 4 0 0 1 0 7.6" /></svg>
  }
}

function NavLink({ href, label, icon, active }: { href: string; label: string; icon: IconName; active: boolean }) {
  return (
    // The tour spotlights these by name; the hook lives on the control so it
    // moves with it. See components/Tour.
    <Link href={href} data-tour={`nav-${href.replace('/', '')}`} className={`aurora-nav-link${active ? ' is-active' : ''}`}>
      <Icon name={icon} />
      <span>{label}</span>
    </Link>
  )
}

export function Nav() {
  const pathname = usePathname()
  const { t } = useI18n()
  /*
   * Prefix matching, EXCEPT where another link owns the deeper path. Without
   * the second clause /monitor-data lit up alongside /monitor-data/retention
   * and both rows looked selected.
   */
  const isActive = (href: string) => {
    if (pathname === href) return true
    if (!pathname.startsWith(href + '/')) return false
    return !links.some(l => l.href !== href && l.href.startsWith(href + '/') && (pathname === l.href || pathname.startsWith(l.href + '/')))
  }

  return (
    <aside className="aurora-sidebar">
      <div className="aurora-sidebar-brand">
        <AuroraLogo size="sm" />
        <span className="aurora-beta"><span>AURORA</span><b>BETA</b></span>
      </div>
      <nav className="aurora-nav">
        <NavLink href="/overview" label={t('nav.overview')} icon="overview" active={isActive('/overview')} />
        {auroraGroups.map(group => {
          const grouped = links.filter(link => link.group === group)
          if (grouped.length === 0) return null
          return (
            <div className="aurora-nav-group" key={group}>
              <div className="aurora-nav-heading">{t(group)}</div>
              {grouped.map(link => <NavLink key={link.href} href={link.href} label={t(link.auroraLabel ?? link.label)} icon={link.icon} active={isActive(link.href)} />)}
            </div>
          )
        })}
      </nav>
      <div className="aurora-sidebar-footer">
        {/* Kept where it can always be found. The tour is skippable and most
            people skip it, which is exactly why it needs a way back — a
            first-run overlay you dismissed once is otherwise gone for good. */}
        <NavLink href="/start" label={t('nav.start')} icon="start" active={isActive('/start')} />
        <NavLink href="/assistant" label={t('nav.assistant')} icon="assistant" active={isActive('/assistant')} />
      </div>
    </aside>
  )
}
