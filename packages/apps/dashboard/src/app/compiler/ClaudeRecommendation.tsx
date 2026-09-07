'use client'

import { useEffect, useState } from 'react'
import { useT } from '@/i18n'

const KEY = 'ow.compiler.recommendation.open'

/**
 * The "write strategies with Claude" pointer, collapsible so the workbench
 * below keeps the viewport. Collapsed by default once the reader has seen it
 * (the choice is remembered per browser).
 */
export function ClaudeRecommendation() {
  const t = useT()
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try { setOpen(localStorage.getItem(KEY) !== 'closed') } catch { setOpen(true) }
  }, [])
  function toggle() {
    setOpen(v => {
      try { localStorage.setItem(KEY, v ? 'closed' : 'open') } catch { /* private mode */ }
      return !v
    })
  }
  return (
    <div className="rounded-lg shrink-0 overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid var(--accent)' }}>
      <button onClick={toggle} className="w-full flex items-center gap-2 px-4 py-2 text-left">
        <span className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>{t('compiler.rec.title')}</span>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#14532d', color: 'var(--success)' }}>{t('compiler.rec.badge')}</span>
        <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 flex flex-col gap-2">
          <p className="text-sm" style={{ color: 'var(--foreground)' }}>
            {t('compiler.rec.introBefore')} <code className="font-mono px-1 rounded" style={{ background: 'var(--background)' }}>skills/openwhale-dev</code> {t('compiler.rec.introAfter')}
          </p>
          <ol className="text-sm list-decimal ml-5 flex flex-col gap-1" style={{ color: 'var(--muted)' }}>
            <li>
              {t('compiler.rec.step1Before')} <code className="font-mono">skills/openwhale-dev/</code> {t('compiler.rec.step1Mid')}
              <code className="font-mono px-1 rounded ml-1" style={{ background: 'var(--background)' }}>.claude/skills/</code>
              {' '}{t('compiler.rec.step1After')}
            </li>
            <li>{t('compiler.rec.step2')}</li>
            <li>{t('compiler.rec.step3')}</li>
          </ol>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            {t('compiler.rec.footer')}
          </p>
        </div>
      )}
    </div>
  )
}
