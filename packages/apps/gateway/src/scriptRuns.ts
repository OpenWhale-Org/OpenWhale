/**
 * Script runs that outlive the connection watching them.
 *
 * A streamed run used to BE its connection: the response closing aborted the
 * script, and the result existed only as the last frame on that one socket.
 * That is the right contract for a script that places orders — hanging up is
 * the operator's last-resort Stop — and the wrong one for a report. A plan
 * preview that keeps this single-threaded process busy cannot feed its own
 * heartbeat, the proxy in front cuts the idle connection at 30s, and the
 * operator presses Run again: on 2026-11-17 seven presses in four minutes
 * left seven full computations stacked on top of the scheduled decision, and
 * not one of them had anyone left to report to.
 *
 * A script that declares itself `background` gets a job instead:
 * - the job runs to its end whoever is watching, and keeps its output for a
 *   while afterwards, so a dropped connection costs nothing but a reconnect;
 * - a second request for the same script with the same params joins the job
 *   already running instead of starting another;
 * - a viewer that reconnects says how many lines it already has and is sent
 *   only the rest.
 *
 * Stop stays what it was: an explicit command that reaches the script's
 * AbortSignal. Only the implicit stop — the hang-up — is gone, and only for
 * scripts that asked for it.
 */

export type RunFrame =
  | { type: 'line'; text: string }
  | { type: 'result'; [k: string]: unknown }
  | { type: 'error'; error: string }

export interface ScriptRun {
  id: string
  /** Script id plus its params — what makes two requests "the same run". */
  key: string
  startedAt: number
  finishedAt?: number
  /** Every line emitted so far, in order; a late viewer replays from here. */
  lines: string[]
  /** The one terminal frame, once the script has returned or thrown. */
  terminal?: RunFrame
  abort: AbortController
  viewers: Set<(frame: RunFrame) => void>
}

/** How long a finished run's output stays reachable for a viewer that lost its connection. */
export const FINISHED_RUN_TTL_MS = 10 * 60_000
/**
 * A run that emits without bound must not grow the heap without bound. Past
 * this many lines the oldest are dropped from the replay log; a viewer that
 * was connected throughout has already seen them.
 */
export const MAX_REPLAY_LINES = 20_000

/** Stable across key order, so `{a,b}` and `{b,a}` are one run. */
export function runKey(scriptId: string, params: Record<string, unknown>): string {
  const sorted = Object.keys(params).sort().map(k => [k, params[k]])
  return `${scriptId}\n${JSON.stringify(sorted)}`
}

export class ScriptRuns {
  private readonly byId = new Map<string, ScriptRun>()
  private readonly runningByKey = new Map<string, ScriptRun>()
  /** A viewer's own token → the run it was given, so its retry finds that run finished or not. */
  private readonly byAttempt = new Map<string, string>()
  /** Lines dropped from the front of each run's replay log. */
  private readonly dropped = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  get(id: string): ScriptRun | undefined { return this.byId.get(id) }

  /**
   * The run this request belongs to: the one its own earlier attempt was
   * given, else one already running with the same key, else a new one.
   */
  open(
    key: string,
    attempt: string | undefined,
    start: (emit: (line: string) => void, signal: AbortSignal, id: string) => Promise<RunFrame>,
  ): { run: ScriptRun; joined: boolean } {
    this.sweep()
    const mine = attempt !== undefined ? this.byId.get(this.byAttempt.get(attempt) ?? '') : undefined
    const existing = mine ?? this.runningByKey.get(key)
    if (existing) {
      if (attempt !== undefined) this.byAttempt.set(attempt, existing.id)
      return { run: existing, joined: true }
    }

    const id = `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const run: ScriptRun = { id, key, startedAt: this.now(), lines: [], abort: new AbortController(), viewers: new Set() }
    this.byId.set(id, run)
    this.runningByKey.set(key, run)
    if (attempt !== undefined) this.byAttempt.set(attempt, id)

    const publish = (frame: RunFrame) => { for (const v of [...run.viewers]) v(frame) }
    const emit = (line: string) => {
      run.lines.push(line)
      if (run.lines.length > MAX_REPLAY_LINES) {
        run.lines.shift()
        this.dropped.set(id, (this.dropped.get(id) ?? 0) + 1)
      }
      publish({ type: 'line', text: line })
    }
    void start(emit, run.abort.signal, id)
      .catch((err): RunFrame => ({ type: 'error', error: err instanceof Error ? err.message : String(err) }))
      .then((terminal) => {
        run.terminal = terminal
        run.finishedAt = this.now()
        if (this.runningByKey.get(key) === run) this.runningByKey.delete(key)
        publish(terminal)
        run.viewers.clear()
      })
    return { run, joined: false }
  }

  /**
   * Feed a viewer everything from line `from` onwards, then whatever follows.
   * Returns the detach function; after the terminal frame there is nothing to
   * detach and it is a no-op.
   */
  watch(run: ScriptRun, from: number, write: (frame: RunFrame) => void): () => void {
    const skipped = this.dropped.get(run.id) ?? 0
    for (const text of run.lines.slice(Math.max(0, from - skipped))) write({ type: 'line', text })
    if (run.terminal !== undefined) { write(run.terminal); return () => {} }
    run.viewers.add(write)
    return () => { run.viewers.delete(write) }
  }

  /** The explicit Stop. False when the run is unknown or already over. */
  stop(id: string): boolean {
    const run = this.byId.get(id)
    if (run === undefined || run.terminal !== undefined) return false
    run.abort.abort()
    return true
  }

  private sweep(): void {
    const cutoff = this.now() - FINISHED_RUN_TTL_MS
    for (const [id, run] of this.byId) {
      if (run.finishedAt === undefined || run.finishedAt >= cutoff) continue
      this.byId.delete(id)
      this.dropped.delete(id)
    }
    for (const [attempt, id] of this.byAttempt) if (!this.byId.has(id)) this.byAttempt.delete(attempt)
  }
}
