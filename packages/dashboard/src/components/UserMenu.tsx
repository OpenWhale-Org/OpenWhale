'use client'

import { useState } from 'react'

/** Signed-in identity plus sign-out. */
export function UserMenu({ username }: { username?: string }) {
  const [busy, setBusy] = useState(false)

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
    <div className="ml-auto flex items-center gap-3">
      <span className="text-xs" style={{ color: 'var(--muted)' }}>{username}</span>
      <button
        onClick={signOut}
        disabled={busy}
        className="text-xs px-2 py-1 rounded-md"
        style={{ border: '1px solid var(--border)', color: 'var(--muted)', opacity: busy ? 0.5 : 1 }}
      >
        Sign out
      </button>
    </div>
  )
}
