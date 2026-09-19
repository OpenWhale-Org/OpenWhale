'use client'

import { useEffect, useState } from 'react'

/** The width below which a layout built for two columns has to become one. */
export const PHONE_QUERY = '(max-width: 760px)'

/**
 * Is this a phone-width viewport?
 *
 * For layouts CSS cannot fix on its own — a positional grid whose cells only
 * make sense in their columns, a drawer sized as a fraction of the page. Where
 * a media query CAN do the job it should: this hook costs a second render and
 * is always false on the server, so the first paint is the wide layout.
 */
export function useIsPhone(): boolean {
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY)
    const apply = () => setPhone(mq.matches)
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [])
  return phone
}
