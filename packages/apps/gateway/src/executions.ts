import fs from 'fs'
import path from 'path'
import type { ExecutionResult } from '@openwhaleorg/core'

/**
 * Reading the execution log — `<dataDir>/executions/<executorId>/<YYYY-MM-DD>.jsonl`.
 *
 * Executors write it; nothing indexes it. That is fine for the questions asked
 * of it (the last N, optionally for one instance), because the files are
 * already ordered — one per executor per UTC day, append-only — so "newest
 * first" is a reverse read of the newest day files, and the scan stops as soon
 * as the page is full.
 *
 * A whole-day file is read at once rather than streamed: a busy executor writes
 * a few MB a day, and the alternative is a line reader that has to be right
 * about torn tail writes. Torn lines are simply skipped here.
 */

export interface ExecutionQuery {
  /** Newest-first page size. */
  limit?: number
  /** Only this instance's executions. */
  instanceId?: string
  /** Only this executor's log directory — the id, as it appears on disk. */
  executorId?: string
  /** 'success' | 'failed' | 'skipped' | 'dry-run' */
  status?: string
  /** Only executions at or after this epoch ms. */
  since?: number
}

export interface ExecutionRecord extends Omit<ExecutionResult, 'executedAt'> {
  /** ISO string as written to disk (JSON has no Date). */
  executedAt: string
  /** Executor whose log this came from — the directory name. */
  executorId: string
}

/** How many day files back a query may reach before it gives up. */
const MAX_DAYS = 7

export async function readExecutions(dataDir: string, query: ExecutionQuery = {}): Promise<ExecutionRecord[]> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000)
  const root = path.join(dataDir, 'executions')
  let executorDirs: string[]
  try {
    executorDirs = await fs.promises.readdir(root)
  } catch {
    return []   // nothing has executed on this install yet
  }
  if (query.executorId) executorDirs = executorDirs.filter(d => d === query.executorId)

  /* Each executor is scanned independently and the results merged, because a
     day file only orders ONE executor's writes; "the last 50 executions" is a
     merge across all of them. Scanning per executor is bounded by MAX_DAYS, so
     an install with a long history does not read its whole past to answer. */
  const collected: ExecutionRecord[] = []
  await Promise.all(executorDirs.map(async (executorId) => {
    const dir = path.join(root, executorId)
    let files: string[]
    try {
      files = (await fs.promises.readdir(dir)).filter(f => f.endsWith('.jsonl')).sort().reverse()
    } catch {
      return
    }
    const mine: ExecutionRecord[] = []
    for (const file of files.slice(0, MAX_DAYS)) {
      let content: string
      try {
        content = await fs.promises.readFile(path.join(dir, file), 'utf8')
      } catch {
        continue   // rotated away between readdir and read
      }
      const lines = content.split('\n')
      for (let i = lines.length - 1; i >= 0 && mine.length < limit; i--) {
        const line = lines[i]!.trim()
        if (!line) continue
        let record: ExecutionRecord
        try {
          record = { ...(JSON.parse(line) as ExecutionRecord), executorId }
        } catch {
          continue   // torn tail write
        }
        if (!matches(record, query)) continue
        mine.push(record)
      }
      if (mine.length >= limit) break
    }
    collected.push(...mine)
  }))

  collected.sort((a, b) => Date.parse(b.executedAt) - Date.parse(a.executedAt))
  return collected.slice(0, limit)
}

function matches(record: ExecutionRecord, query: ExecutionQuery): boolean {
  if (query.instanceId && record.instruction?.instanceId !== query.instanceId) return false
  if (query.status && record.status !== query.status) return false
  if (query.since !== undefined && Date.parse(record.executedAt) < query.since) return false
  return true
}
