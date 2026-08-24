'use client'

import { useEffect, useState } from 'react'

const KEY = 'ow.compiler.recommendation.open'

/**
 * The "write strategies with Claude" pointer, collapsible so the workbench
 * below keeps the viewport. Collapsed by default once the reader has seen it
 * (the choice is remembered per browser).
 */
export function ClaudeRecommendation() {
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
        <span className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>Recommended: write strategies with Claude</span>
        <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: '#14532d', color: 'var(--success)' }}>Recommended</span>
        <span className="ml-auto text-xs" style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-4 pb-3 flex flex-col gap-2">
          <p className="text-sm" style={{ color: 'var(--foreground)' }}>
            This repo ships the <code className="font-mono px-1 rounded" style={{ background: 'var(--background)' }}>skills/openwhale-dev</code> skill:
            it teaches any Claude (Claude Code / claude.ai) the full OpenWhale contract so it can write installable, runnable
            Strategies / Monitors / Executors — even whole plugins and Kind extensions. Stronger than the Compiler, iterable in conversation, tests included.
          </p>
          <ol className="text-sm list-decimal ml-5 flex flex-col gap-1" style={{ color: 'var(--muted)' }}>
            <li>
              Copy <code className="font-mono">skills/openwhale-dev/</code> into your plugin project under
              <code className="font-mono px-1 rounded ml-1" style={{ background: 'var(--background)' }}>.claude/skills/</code>
              (or reference this repo&apos;s path directly in Claude Code)
            </li>
            <li>Describe your strategy idea; Claude produces a complete plugin package with tests</li>
            <li>Install it from the Plugins page via the package&apos;s absolute local path</li>
          </ol>
          <p className="text-xs" style={{ color: 'var(--muted)' }}>
            The Compiler below remains available but experimental — for complex strategies prefer the Claude + Skill route.
          </p>
        </div>
      )}
    </div>
  )
}
