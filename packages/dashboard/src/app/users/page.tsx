import { fetchUsers, fetchCurrentUser } from '@/lib/data'
import { UsersClient } from './UsersClient'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  const [users, me] = await Promise.all([fetchUsers(), fetchCurrentUser()])
  return <UsersClient initialUsers={users} {...(me.user?.id ? { currentUserId: me.user.id } : {})} />
}
