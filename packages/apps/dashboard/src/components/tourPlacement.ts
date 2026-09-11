import type { CSSProperties } from 'react'

const CARD_WIDTH = 340
const CARD_HEIGHT = 260
const GAP = 20
const MARGIN = 16

/**
 * Put the guide card outside its spotlight.
 *
 * A dialog-sized spotlight may leave no band wide enough for the preferred
 * 340px card. In that case the card uses the largest real band and becomes a
 * narrow, scrollable rail instead of falling back on top of the control the
 * operator must use. Width/height constraints are part of the returned style,
 * so wrapped copy cannot grow back across the spotlight.
 */
export function placeCard(rect: DOMRect | null): CSSProperties {
  if (typeof window === 'undefined') return {}
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  if (!rect) return { left: '50%', bottom: 40, transform: 'translateX(-50%)', width: CARD_WIDTH }

  const bands = {
    right: Math.max(0, viewportWidth - rect.right - GAP - MARGIN),
    left: Math.max(0, rect.left - GAP - MARGIN),
    below: Math.max(0, viewportHeight - rect.bottom - GAP - MARGIN),
    above: Math.max(0, rect.top - GAP - MARGIN),
  }

  // Preserve the comfortable card size whenever a complete band accepts it.
  if (bands.right >= CARD_WIDTH) {
    return sideCard(rect.right + GAP, rect.top - 8, CARD_WIDTH, viewportHeight)
  }
  if (bands.left >= CARD_WIDTH) {
    return sideCard(rect.left - CARD_WIDTH - GAP, rect.top - 8, CARD_WIDTH, viewportHeight)
  }
  if (bands.below >= CARD_HEIGHT) {
    return horizontalCard(rect.bottom + GAP, bands.below, rect.left, viewportWidth)
  }
  if (bands.above >= CARD_HEIGHT) {
    return horizontalCard(MARGIN, bands.above, rect.left, viewportWidth)
  }

  // No full-size fit: use the largest available band and constrain the card
  // inside it. This is the #48 case — a near-full-screen form leaves a narrow
  // rail on the right, but the old all-or-nothing check ignored that rail.
  const side = (Object.entries(bands) as Array<[keyof typeof bands, number]>)
    .sort(
      (a, b) =>
        bandArea(b[0], b[1], viewportWidth, viewportHeight) -
        bandArea(a[0], a[1], viewportWidth, viewportHeight),
    )[0]![0]

  if (side === 'right') {
    return sideCard(rect.right + GAP, rect.top - 8, Math.max(1, bands.right), viewportHeight)
  }
  if (side === 'left') {
    return sideCard(MARGIN, rect.top - 8, Math.max(1, bands.left), viewportHeight)
  }
  if (side === 'below') {
    return horizontalCard(rect.bottom + GAP, Math.max(1, bands.below), rect.left, viewportWidth)
  }
  return horizontalCard(MARGIN, Math.max(1, bands.above), rect.left, viewportWidth)
}

function sideCard(left: number, preferredTop: number, width: number, viewportHeight: number): CSSProperties {
  return {
    left,
    top: Math.min(Math.max(MARGIN, preferredTop), Math.max(MARGIN, viewportHeight - CARD_HEIGHT - MARGIN)),
    width,
    maxHeight: viewportHeight - MARGIN * 2,
    overflowY: 'auto',
  }
}

function horizontalCard(top: number, height: number, preferredLeft: number, viewportWidth: number): CSSProperties {
  return {
    left: Math.min(Math.max(MARGIN, preferredLeft), Math.max(MARGIN, viewportWidth - CARD_WIDTH - MARGIN)),
    top,
    width: Math.min(CARD_WIDTH, viewportWidth - MARGIN * 2),
    maxHeight: height,
    overflowY: 'auto',
  }
}

function bandArea(side: 'right' | 'left' | 'below' | 'above', size: number, viewportWidth: number, viewportHeight: number): number {
  return (side === 'right' || side === 'left' ? viewportHeight : viewportWidth) * size
}
