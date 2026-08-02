import { ScriptsClient } from './ScriptsClient'

export const dynamic = 'force-dynamic'

export default function ScriptsPage() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Scripts</h1>
      </div>
      <ScriptsClient />
    </div>
  )
}
