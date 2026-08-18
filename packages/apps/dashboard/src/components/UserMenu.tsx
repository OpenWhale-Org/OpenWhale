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
    <div className="aurora-user-menu">
      <span className="aurora-avatar">{username.slice(0, 2).toUpperCase()}</span>
      <button onClick={signOut} disabled={busy} className="aurora-signout" style={{ opacity: busy ? 0.5 : 1 }}>
        Sign out
      </button>
    </div>
  )
}
