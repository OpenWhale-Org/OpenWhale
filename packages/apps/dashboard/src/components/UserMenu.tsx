'use client'

import { useState } from 'react'
import { useUiMode } from './UiModeProvider'

/** Signed-in identity plus sign-out. */
export function UserMenu({ username }: { username?: string }) {
  const [busy, setBusy] = useState(false)
  const { mode, setMode } = useUiMode()

  async function signOut() {
    setBusy(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
    } catch { /* the cookie is cleared either way; a dead gateway must not trap the user */ }
    // Full navigation so the middleware re-evaluates against the cleared cookie
    window.location.href = '/login'
  }

  if (!username) return null
  return (
    <div className={mode === 'aurora' ? 'aurora-user-menu' : 'ml-auto flex items-center gap-3'}>
      {mode === 'classic' && (
        <button onClick={() => setMode('aurora')} className="aurora-preview-button" title="Preview the new Aurora interface">
          <span className="aurora-preview-spark">✦</span>
          Experience Aurora UI
          <span className="aurora-preview-beta">BETA</span>
        </button>
      )}
      {mode === 'aurora' && <button className="aurora-icon-button" title="Search"><span>⌘ K</span></button>}
      {mode === 'aurora' && <button className="aurora-icon-button" title="Notifications" aria-label="Notifications">♢</button>}
      <span className={mode === 'aurora' ? 'aurora-avatar' : 'text-xs'} style={mode === 'aurora' ? undefined : { color: 'var(--muted)' }}>{mode === 'aurora' ? username.slice(0, 2).toUpperCase() : username}</span>
      <button
        onClick={signOut}
        disabled={busy}
        className={mode === 'aurora' ? 'aurora-signout' : 'text-xs px-2 py-1 rounded-md'}
        style={mode === 'aurora' ? { opacity: busy ? 0.5 : 1 } : { border: '1px solid var(--border)', color: 'var(--muted)', opacity: busy ? 0.5 : 1 }}
      >
        Sign out
      </button>
    </div>
  )
}
