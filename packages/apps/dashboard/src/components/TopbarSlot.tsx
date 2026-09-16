'use client'

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Render something into the shell's breadcrumb, after the page label.
 *
 * A page deep in the tree cannot reach the topbar by composition — the shell
 * wraps it, not the other way round — so the shell leaves an empty node and
 * this portals into it. The separator is drawn by CSS on `:not(:empty)`, so a
 * page that fills nothing in leaves the breadcrumb exactly as it was.
 */
export const TOPBAR_SLOT_ID = 'aurora-topbar-slot'

export function TopbarSlot({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)

  // The shell's header is committed before a child's effects run, so one look
  // is enough; a re-mount of this component looks again.
  useEffect(() => { setHost(document.getElementById(TOPBAR_SLOT_ID)) }, [])

  if (!host) return null
  return createPortal(children, host)
}
