'use client'

import { useState } from 'react'
import type { CredentialTypeInfo } from '@openwhaleorg/core'

/**
 * A type's mark: its logo, else its glyph, else the first letter of its name.
 *
 * The letter is drawn in a bordered chip so it reads as a mark rather than as
 * a stray character next to the name, and a logo that fails to load falls back
 * to the same chain — a broken image never leaves a hole in the row.
 */
export function TypeMark({ logo, icon, label, size = 22 }: {
  logo?: string | undefined
  icon?: string | undefined
  label: string
  size?: number
}) {
  const [broken, setBroken] = useState(false)
  const showLogo = logo !== undefined && !broken

  if (showLogo) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- logos come from
      // plugins as URLs or data: URIs; next/image needs build-time known hosts.
      <img
        src={logo}
        alt=""
        onError={() => setBroken(true)}
        className="shrink-0 object-cover"
        /* Fully round, not rounded: most of these bitmaps ship on an opaque
           square, and against a dark row the corners read as a white box. */
        style={{ width: size, height: size, borderRadius: '50%' }}
      />
    )
  }
  if (icon !== undefined) {
    return (
      <span className="shrink-0 grid place-items-center" style={{ width: size, height: size, fontSize: Math.round(size * 0.73), lineHeight: 1 }} aria-hidden>
        {icon}
      </span>
    )
  }
  return (
    <span
      className="shrink-0 grid place-items-center"
      style={{
        width: size, height: size, borderRadius: Math.round(size / 3.6),
        fontSize: Math.round(size * 0.5), fontWeight: 600,
        background: 'var(--background)', color: 'var(--muted)', border: '1px solid var(--border)',
      }}
      aria-hidden
    >
      {(Array.from(label)[0] ?? '?').toUpperCase()}
    </span>
  )
}

/**
 * The mark for whatever credential an account is bound to.
 *
 * Accounts do not carry a type of their own — they carry a credential name,
 * and the credential carries the type. Resolving that here keeps both pages
 * showing the same brand for the same venue instead of each inventing one.
 */
export function CredentialMark({ credential, credentials, credentialTypes, size = 22 }: {
  credential: string | undefined
  credentials: Array<{ name: string; type: string }>
  credentialTypes: CredentialTypeInfo[]
  size?: number
}) {
  const cred = credential ? credentials.find(c => c.name === credential) : undefined
  const info = cred ? credentialTypes.find(t => t.type === cred.type) : undefined
  return (
    <TypeMark
      logo={info?.logo}
      icon={info?.icon}
      label={info?.displayName ?? cred?.type ?? credential ?? '?'}
      size={size}
    />
  )
}
