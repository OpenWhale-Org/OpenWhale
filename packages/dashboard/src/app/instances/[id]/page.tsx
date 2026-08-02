import { InstanceBoardClient } from './InstanceBoardClient'

export const dynamic = 'force-dynamic'

export default async function InstanceBoardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <InstanceBoardClient instanceId={id} />
}
