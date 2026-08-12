import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { UI_MODE_COOKIE } from '@/lib/ui-mode'

export default async function Home() {
  const store = await cookies()
  redirect(store.get(UI_MODE_COOKIE)?.value === 'aurora' ? '/overview' : '/instances')
}
