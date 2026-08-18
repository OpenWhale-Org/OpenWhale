import { redirect } from 'next/navigation'

/**
 * Root redirect. This used to branch on the UI cookie — Classic landed on
 * /instances, Aurora on /overview. Classic was retired on 2026-08-17, so
 * everyone lands on the overview.
 */
export default function Home() {
  redirect('/overview')
}
