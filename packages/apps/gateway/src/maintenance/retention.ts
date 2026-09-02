import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { pruneJsonlByTime, matchesKeyPattern, decodeMonitorKey, getLogger } from '@openwhaleorg/core'
import type { SQLiteAdapter, OpenWhaleRuntime } from '@openwhaleorg/core'

const log = getLogger().child({ module: 'MonitorRetention' })

/**
 * Scheduled pruning of monitor stores.
 *
 * Opt-in per store, never global. Some of these files are the historical
 * record a strategy fits its baseline against — a blanket "keep 30 days"
 * would quietly change what those strategies see. So nothing is pruned until
 * an operator names a target and a horizon.
 */
export interface RetentionPolicy {
  id: string
  /** Monitor directory name, or '*' for every monitor. */
  monitor: string
  /** Glob over the decoded key, '*' for every key in that monitor. */
  keyPattern: string
  /** Records older than this many days are dropped. Fractional is allowed. */
  keepDays: number
  enabled: boolean
  lastRunAt?: string
  lastResult?: RunSummary
}

export interface RunSummary {
  at: string
  files: number
  droppedRecords: number
  bytesFreed: number
  errors: string[]
}

/** One entry in the run history. */
export interface RetentionRun extends RunSummary {
  id: number
  policyId: string
  monitor: string
  keyPattern: string
  keepDays: number
  /** 'scheduled' for the hourly sweep, 'manual' for a button. */
  trigger: 'scheduled' | 'manual'
}

/** One matched store. `file` is carried from the walk rather than rebuilt. */
export interface MatchedFile {
  monitor: string
  key: string
  bytes: number
  updatedAt: number
  /** Absolute path. Never sent to a client — see the routes. */
  file: string
}

interface Row {
  [k: string]: unknown
  id: string
  monitor: string
  key_pattern: string
  keep_days: number
  enabled: number
  last_run_at: string | null
  last_result: string | null
}

const HOUR_MS = 3_600_000
/** Rows kept in the run history — see `record`. */
const HISTORY_CAP = 500

function toPolicy(row: Row): RetentionPolicy {
  let lastResult: RunSummary | undefined
  if (row.last_result) {
    try { lastResult = JSON.parse(row.last_result) as RunSummary } catch { /* advisory */ }
  }
  return {
    id: row.id,
    monitor: row.monitor,
    keyPattern: row.key_pattern,
    keepDays: row.keep_days,
    enabled: row.enabled === 1,
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    ...(lastResult ? { lastResult } : {}),
  }
}

export class RetentionService {
  private timer: ReturnType<typeof setInterval> | undefined
  private running = false

  constructor(
    private readonly db: SQLiteAdapter,
    private readonly runtime: OpenWhaleRuntime,
  ) {}

  async initialize(): Promise<void> {
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS monitor_retention_policies (
        id          TEXT PRIMARY KEY,
        monitor     TEXT NOT NULL,
        key_pattern TEXT NOT NULL,
        keep_days   REAL NOT NULL,
        enabled     INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        last_result TEXT,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      )
    `)
    await this.db.run(`
      CREATE TABLE IF NOT EXISTS monitor_retention_runs (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        policy_id       TEXT NOT NULL,
        monitor         TEXT NOT NULL,
        key_pattern     TEXT NOT NULL,
        keep_days       REAL NOT NULL,
        at              TEXT NOT NULL,
        files           INTEGER NOT NULL,
        dropped_records INTEGER NOT NULL,
        bytes_freed     INTEGER NOT NULL,
        errors          TEXT NOT NULL,
        trigger         TEXT NOT NULL
      )
    `)
    await this.db.run('CREATE INDEX IF NOT EXISTS idx_retention_runs_at ON monitor_retention_runs (at DESC)')
    // Hourly is fine for a housekeeping job whose horizons are measured in
    // days — and it means a policy saved now takes effect within the hour
    // without a restart. unref'd so it never holds the process open.
    this.timer = setInterval(() => { void this.sweep() }, HOUR_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private get monitorsDir(): string {
    return path.join(this.runtime.dataDirPath, 'monitors')
  }

  // ── policies ──────────────────────────────────────────────────────────────

  async list(): Promise<RetentionPolicy[]> {
    const rows = await this.db.all<Row>('SELECT * FROM monitor_retention_policies ORDER BY monitor, key_pattern')
    return rows.map(toPolicy)
  }

  async upsert(input: Partial<RetentionPolicy>): Promise<RetentionPolicy> {
    const monitor = (input.monitor ?? '').trim()
    const keyPattern = (input.keyPattern ?? '*').trim() || '*'
    const keepDays = Number(input.keepDays)
    if (!monitor) throw new Error('monitor is required')
    if (!Number.isFinite(keepDays) || keepDays <= 0) throw new Error('keepDays must be a positive number')

    const now = new Date().toISOString()
    const id = input.id ?? randomUUID()
    const enabled = input.enabled === false ? 0 : 1
    await this.db.run(
      `INSERT INTO monitor_retention_policies (id, monitor, key_pattern, keep_days, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         monitor = excluded.monitor, key_pattern = excluded.key_pattern,
         keep_days = excluded.keep_days, enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [id, monitor, keyPattern, keepDays, enabled, now, now],
    )
    const row = await this.db.get<Row>('SELECT * FROM monitor_retention_policies WHERE id = ?', [id])
    if (!row) throw new Error('policy vanished after write')
    return toPolicy(row)
  }

  async remove(id: string): Promise<void> {
    await this.db.run('DELETE FROM monitor_retention_policies WHERE id = ?', [id])
  }

  // ── matching ──────────────────────────────────────────────────────────────

  /** Every .jsonl under a monitor dir, with its decoded key. */
  private walk(monitorDir: string, monitor: string, prefix = ''): MatchedFile[] {
    const out: MatchedFile[] = []
    let entries: string[] = []
    try { entries = fs.readdirSync(monitorDir) } catch { return out }
    for (const entry of entries) {
      const full = path.join(monitorDir, entry)
      let stat: fs.Stats
      try { stat = fs.statSync(full) } catch { continue }
      if (stat.isDirectory()) {
        out.push(...this.walk(full, monitor, `${prefix}${entry}/`))
      } else if (entry.endsWith('.jsonl')) {
        out.push({
          monitor,
          key: decodeMonitorKey(`${prefix}${entry.slice(0, -6)}`),
          bytes: stat.size,
          updatedAt: stat.mtimeMs,
          file: full,
        })
      }
    }
    return out
  }

  /** Files a policy's (monitor, keyPattern) selects, largest first. */
  matches(monitor: string, keyPattern: string): MatchedFile[] {
    const root = this.monitorsDir
    let dirs: string[]
    if (monitor === '*') {
      try { dirs = fs.readdirSync(root).filter(d => fs.statSync(path.join(root, d)).isDirectory()) } catch { dirs = [] }
    } else {
      dirs = [monitor]
    }
    const out: MatchedFile[] = []
    for (const dir of dirs) {
      const full = path.join(root, path.basename(dir))
      if (!full.startsWith(root)) continue
      out.push(...this.walk(full, dir).filter(f => matchesKeyPattern(f.key, keyPattern)))
    }
    return out.sort((a, b) => b.bytes - a.bytes)
  }

  // ── execution ─────────────────────────────────────────────────────────────

  /**
   * Apply one policy. `dryRun` reports what would go without touching a byte —
   * the page calls it on every keystroke so an operator sees the cost of a
   * horizon before committing to it.
   */
  async apply(policy: Pick<RetentionPolicy, 'monitor' | 'keyPattern' | 'keepDays'>, dryRun: boolean): Promise<RunSummary> {
    const cutoff = Date.now() - policy.keepDays * 86_400_000
    const summary: RunSummary = { at: new Date().toISOString(), files: 0, droppedRecords: 0, bytesFreed: 0, errors: [] }
    for (const match of this.matches(policy.monitor, policy.keyPattern)) {
      try {
        const r = await pruneJsonlByTime(match.file, cutoff, { dryRun })
        if (r.dropped === 0) continue
        summary.files++
        summary.droppedRecords += r.dropped
        summary.bytesFreed += r.bytesBefore - r.bytesAfter
      } catch (err) {
        // One unreadable store must not abort the sweep — the rest still needs
        // pruning, and the operator needs to see which one failed.
        summary.errors.push(`${match.monitor}/${match.key}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return summary
  }

  /** Run one saved policy now and record the outcome. */
  async runPolicy(id: string, trigger: 'scheduled' | 'manual' = 'manual'): Promise<RunSummary> {
    const row = await this.db.get<Row>('SELECT * FROM monitor_retention_policies WHERE id = ?', [id])
    if (!row) throw new Error('no such policy')
    const policy = toPolicy(row)
    const summary = await this.apply(policy, false)
    // last_run_at moves on EVERY pass — that is what answers "is this policy
    // still alive". The history below is the opposite question, so it only
    // takes passes that did something.
    await this.db.run(
      'UPDATE monitor_retention_policies SET last_run_at = ?, last_result = ? WHERE id = ?',
      [summary.at, JSON.stringify(summary), id],
    )
    if (summary.files > 0 || summary.errors.length > 0) await this.record(policy, summary, trigger)
    return summary
  }

  /**
   * Append to the run history, then trim it.
   *
   * A log about reclaiming disk that grows without bound would be its own
   * punchline. Only passes that moved something get a row, and the newest
   * HISTORY_CAP survive — enough to answer "what did this actually delete,
   * and when" long after the fact.
   */
  private async record(
    policy: Pick<RetentionPolicy, 'id' | 'monitor' | 'keyPattern' | 'keepDays'>,
    summary: RunSummary,
    trigger: 'scheduled' | 'manual',
  ): Promise<void> {
    await this.db.run(
      `INSERT INTO monitor_retention_runs
         (policy_id, monitor, key_pattern, keep_days, at, files, dropped_records, bytes_freed, errors, trigger)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [policy.id, policy.monitor, policy.keyPattern, policy.keepDays, summary.at,
        summary.files, summary.droppedRecords, summary.bytesFreed, JSON.stringify(summary.errors), trigger],
    )
    await this.db.run(
      `DELETE FROM monitor_retention_runs WHERE id NOT IN (
         SELECT id FROM monitor_retention_runs ORDER BY id DESC LIMIT ?
       )`,
      [HISTORY_CAP],
    )
  }

  /** Newest first. */
  async runs(limit = 100): Promise<RetentionRun[]> {
    const rows = await this.db.all<Row>(
      'SELECT * FROM monitor_retention_runs ORDER BY id DESC LIMIT ?',
      [Math.min(Math.max(limit, 1), HISTORY_CAP)],
    )
    return rows.map(r => {
      let errors: string[] = []
      try { errors = JSON.parse(String(r.errors)) as string[] } catch { /* advisory */ }
      return {
        id: Number(r.id),
        policyId: String(r.policy_id),
        monitor: String(r.monitor),
        keyPattern: String(r.key_pattern),
        keepDays: Number(r.keep_days),
        at: String(r.at),
        files: Number(r.files),
        droppedRecords: Number(r.dropped_records),
        bytesFreed: Number(r.bytes_freed),
        trigger: r.trigger === 'scheduled' ? 'scheduled' : 'manual',
        errors,
      }
    })
  }

  /** The scheduled pass: every enabled policy, one after another. */
  async sweep(): Promise<RunSummary[]> {
    if (this.running) return []
    this.running = true
    try {
      const out: RunSummary[] = []
      for (const policy of await this.list()) {
        if (!policy.enabled) continue
        try {
          const summary = await this.runPolicy(policy.id, 'scheduled')
          if (summary.files > 0)
            log.info({ monitor: policy.monitor, keyPattern: policy.keyPattern, ...summary }, 'Pruned monitor data')
          out.push(summary)
        } catch (err) {
          log.error({ policyId: policy.id, err }, 'Retention policy failed')
        }
      }
      return out
    } finally {
      this.running = false
    }
  }
}

let service: RetentionService | undefined
export function setRetentionService(s: RetentionService): void { service = s }
export function getRetentionService(): RetentionService | undefined { return service }
