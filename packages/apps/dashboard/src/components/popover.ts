'use client'

import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Placement for a list that hangs off a control but is rendered into <body>.
 *
 * An absolutely positioned popover is clipped by any ancestor with
 * `overflow: hidden` — the parameter form's section boxes and every modal are
 * exactly that — so pickers portal their list and position it in viewport
 * coordinates instead. This computes those coordinates and keeps them current
 * while the popover is open.
 */

export interface Placement {
  left: number
  width: number
  /** One of top/bottom is set: `bottom` means the list opened upwards. */
  top?: number
  bottom?: number
  maxHeight: number
}

const GAP = 4
const MARGIN = 8

export function placeBelow(anchor: DOMRect, maxHeight: number, minWidth = 0): Placement {
  const below = window.innerHeight - anchor.bottom - GAP - MARGIN
  const above = anchor.top - GAP - MARGIN
  // Open downwards unless below is cramped and above genuinely has more room
  const flip = below < Math.min(maxHeight, above) && above > below
  const width = Math.max(anchor.width, minWidth)
  const left = Math.min(anchor.left, Math.max(MARGIN, window.innerWidth - width - MARGIN))
  return flip
    ? { left, width, bottom: window.innerHeight - anchor.top + GAP, maxHeight: Math.min(maxHeight, above) }
    : { left, width, top: anchor.bottom + GAP, maxHeight: Math.min(maxHeight, below) }
}

/**
 * Track an anchor element's box while `open`. Scroll is listened to in the
 * capture phase so a scrolling ANCESTOR moves the list too, not just the
 * window; resize re-decides whether it opens up or down.
 */
export function useAnchoredPlacement(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  { maxHeight, minWidth = 0 }: { maxHeight: number; minWidth?: number },
): Placement | null {
  const [place, setPlace] = useState<Placement | null>(null)
  useLayoutEffect(() => {
    if (!open) { setPlace(null); return }
    const sync = () => {
      const el = anchorRef.current
      if (el) setPlace(placeBelow(el.getBoundingClientRect(), maxHeight, minWidth))
    }
    sync()
    window.addEventListener('scroll', sync, true)
    window.addEventListener('resize', sync)
    return () => {
      window.removeEventListener('scroll', sync, true)
      window.removeEventListener('resize', sync)
    }
  }, [open, anchorRef, maxHeight, minWidth])
  return place
}
