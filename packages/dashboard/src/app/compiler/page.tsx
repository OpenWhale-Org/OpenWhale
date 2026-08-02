import { CompilerClient } from './CompilerClient'
import { fetchCompilerJobs } from '@/lib/data'

export const dynamic = 'force-dynamic'

export default async function CompilerPage() {
  const jobs = await fetchCompilerJobs()
  return (
    <div>
      <div className="mb-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Compiler</h1>
          <span
            className="text-xs px-2 py-0.5 rounded-full font-medium"
            style={{ background: '#422006', color: 'var(--warning)', border: '1px solid #713f12' }}
          >
            Experimental
          </span>
        </div>
        <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>
          Natural language → analyzed, generated, validated strategy code. You review and approve; nothing runs without you.
        </p>
      </div>

      {/* Recommended path: author with Claude + the openwhale-dev skill */}
      <div
        className="rounded-lg p-4 mb-6 flex flex-col gap-2"
        style={{ background: 'var(--surface)', border: '1px solid var(--accent)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>
            Recommended: write strategies with Claude
          </span>
          <span
            className="text-xs px-2 py-0.5 rounded-full"
            style={{ background: '#14532d', color: 'var(--success)' }}
          >
            Recommended
          </span>
        </div>
        <p className="text-sm" style={{ color: 'var(--foreground)' }}>
          This repo ships the <code className="font-mono px-1 rounded" style={{ background: 'var(--background)' }}>skills/openwhale-dev</code> skill:
          it teaches any Claude (Claude Code / claude.ai) the full OpenWhale contract so it can write installable, runnable
          Strategies / Monitors / Executors — even whole plugins and Kind extensions. Stronger than the Compiler, iterable in conversation, tests included.
        </p>
        <ol className="text-sm list-decimal ml-5 flex flex-col gap-1" style={{ color: 'var(--muted)' }}>
          <li>
            Copy <code className="font-mono">skills/openwhale-dev/</code> into your plugin project under
            <code className="font-mono px-1 rounded ml-1" style={{ background: 'var(--background)' }}>.claude/skills/</code>
            (or reference this repo's path directly in Claude Code)
          </li>
          <li>Describe your strategy idea; Claude produces a complete plugin package with tests</li>
          <li>Install it from the Plugins page via the package's absolute local path</li>
        </ol>
        <p className="text-xs" style={{ color: 'var(--muted)' }}>
          The Compiler below remains available but experimental — for complex strategies prefer the Claude + Skill route.
        </p>
      </div>

      <CompilerClient initialJobs={jobs} />
    </div>
  )
}
