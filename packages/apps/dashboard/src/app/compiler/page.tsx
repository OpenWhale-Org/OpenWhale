import { CompilerClient } from './CompilerClient'
import { ClaudeRecommendation } from './ClaudeRecommendation'
import { fetchCompilerJobs } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function CompilerPage() {
  const jobs = await fetchCompilerJobs()
  return (
    // Fills the main area exactly (topbar 54px + main padding 22px/28px) so
    // the workbench owns the viewport and nothing on the page scrolls.
    <div className="flex flex-col gap-3" style={{ height: 'calc(100vh - 104px)' }}>
      <div className="shrink-0 flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Compiler</h1>
        <span
          className="text-xs px-2 py-0.5 rounded-full font-medium"
          style={{ background: '#422006', color: 'var(--warning)', border: '1px solid #713f12' }}
        >
          Experimental
        </span>
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          Natural language → analyzed, generated, validated code. You review and approve; nothing runs without you.
        </p>
      </div>
      <ClaudeRecommendation />
      <CompilerClient initialJobs={jobs} />
    </div>
  )
}
