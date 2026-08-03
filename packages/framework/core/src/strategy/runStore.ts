import fs from 'fs'
import path from 'path'
import type { StrategyRunTrace } from '../types/strategy.js'

/**
 * On-disk run traces — `<dataDir>/runs/<instanceId>/<YYYY-MM-DD>.jsonl`.
 *
 * The in-memory ring on BaseStrategy dies with the strategy object, so a
 * deactivated instance would have no audit trail at all. Persisting fixes
 * that, but a ladder strategy runs on every monitor emit (every ~2s) and
 * almost always decides "do nothing": writing all of those would grow by
 * ~100MB/day per instance. So runs that emitted instructions or errored are
 * always kept, while no-op runs are sampled down to one heartbeat per
 * HEARTBEAT_MS — enough to prove the instance was alive and show what it was
 * seeing, without the flood.
 */
const HEARTBEAT_MS = 10 * 60_000

const lastNoopAt = new Map<string, number>()

function runsDir(dataDir: string, instanceId: string): string {
  return path.join(dataDir, 'runs', instanceId)
}

export async function appendRunTrace(dataDir: string, instanceId: string, run: StrategyRunTrace): Promise<void> {
  if (run.instructions === 0 && run.error === undefined) {
    const last = lastNoopAt.get(instanceId) ?? 0
    if (run.startedAt - last < HEARTBEAT_MS) return
    lastNoopAt.set(instanceId, run.startedAt)
  }
  const dir = runsDir(dataDir, instanceId)
  const file = path.join(dir, `${new Date(run.startedAt).toISOString().slice(0, 10)}.jsonl`)
  await fs.promises.mkdir(dir, { recursive: true })
  await fs.promises.appendFile(file, JSON.stringify(run) + '\n', 'utf8')
}

/** Newest-first, at most `limit`, drawn from the most recent day files. */
export async function readRunTraces(dataDir: string, instanceId: string, limit = 100): Promise<StrategyRunTrace[]> {
  let files: string[]
  try {
    files = (await fs.promises.readdir(runsDir(dataDir, instanceId)))
      .filter(f => f.endsWith('.jsonl')).sort().reverse()
  } catch {
    return []
  }
  const out: StrategyRunTrace[] = []
  for (const f of files.slice(0, 7)) {
    const lines = (await fs.promises.readFile(path.join(runsDir(dataDir, instanceId), f), 'utf8')).split('\n')
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i]!.trim()
      if (!line) continue
      try { out.push(JSON.parse(line) as StrategyRunTrace) } catch { /* torn tail write */ }
    }
    if (out.length >= limit) break
  }
  return out
}
