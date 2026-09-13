'use client'

import { setActiveTimeZone } from '@/lib/time'

/**
 * Applies the reader's time zone before the tree renders.
 *
 * It runs during render rather than in an effect on purpose: an effect fires
 * after the first paint, which would format every visible time in the server's
 * zone and then correct it — a flash of the wrong hour on every page load.
 * Rendering nothing, it is only here for that assignment.
 */
export function TimeZoneBoot({ zone }: { zone: string }) {
  setActiveTimeZone(zone)
  return null
}
