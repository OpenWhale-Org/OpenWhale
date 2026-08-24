import { EventEmitter } from 'events'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import type { OpenWhaleRuntime, CredentialStore, CompiledLoader } from '@openwhaleorg/core'
import { LlmClient, getDataDir, getCompiledSourcePath } from '@openwhaleorg/core'
import { JobStore } from './JobStore.js'
import { runAnalyzer, runCodegen, runFixer, runRefiner } from './agents.js'
import type { AgentContext } from './agents.js'
import { validateDraft } from './validate.js'
import type { CompileJob, CompileTarget, CompilerEvent, CompilerOptions, CompilerSettings, DraftFile, DraftVersion, CodegenOutput, JobStatus } from './types.js'
import { draftFileSchema } from './types.js'

/**
 * Bare API errors ("Not Found") are undebuggable — surface the endpoint,
 * status, and response body that AI SDK APICallError carries.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const api = err as Error & { url?: string; statusCode?: number; responseBody?: string }
  if (api.url || api.statusCode) {
    const body = typeof api.responseBody === 'string' ? ` — ${api.responseBody.slice(0, 300)}` : ''
    return `LLM API error: ${err.message} (HTTP ${api.statusCode ?? '?'} ${api.url ?? ''})${body}`
  }
  return err.message
}

export interface CompilerServiceDeps {
  runtime: OpenWhaleRuntime
  credentialStore: CredentialStore
  /** The runtime's CompiledLoader — approve() registers drafts through it. */
  compiledLoader: CompiledLoader
}

/**
 * Orchestrates compile jobs: NL description → analyzer → user confirmation →
 * codegen → validation ladder × fixer → conversational draft → approve.
 * Emits 'event' (CompilerEvent) for SSE forwarding. All state persists via
 * JobStore, so drafts survive restarts.
 */
export class CompilerService extends EventEmitter {
  private readonly store: JobStore
  private readonly llm: LlmClient
  private readonly dataDir: string
  private readonly defaultModel: string
  private readonly maxFixRounds: number
  private readonly maxAnalyzerSteps: number
  private readonly dryRunTimeoutMs: number
  /** In-flight pipeline per job — one at a time per job. */
  private readonly running = new Set<string>()

  constructor(private readonly deps: CompilerServiceDeps, options?: CompilerOptions) {
    super()
    this.dataDir = getDataDir(options?.dataDir)
    this.store = new JobStore(this.dataDir)
    this.defaultModel = options?.model ?? 'anthropic:claude-sonnet-5'
    this.maxFixRounds = options?.maxFixRounds ?? 4
    this.maxAnalyzerSteps = options?.maxAnalyzerSteps ?? 24
    this.dryRunTimeoutMs = options?.dryRunTimeoutMs ?? 15_000
    this.llm = new LlmClient()
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  private emitEvent(jobId: string, partial: Omit<CompilerEvent, 'jobId' | 'ts'>): void {
    this.emit('event', { jobId, ts: Date.now(), ...partial } satisfies CompilerEvent)
  }

  private agentContext(jobId: string): AgentContext {
    const settings = this.getSettings()
    return {
      runtime: this.deps.runtime,
      llm: this.llm,
      credentials: this.deps.credentialStore,
      model: settings.model,
      ...(settings.credentialName ? { credentialName: settings.credentialName } : {}),
      log: (message) => { void this.progress(jobId, message) },
    }
  }

  /** Append a progress line to the job (capped) and push it over SSE. */
  private async progress(jobId: string, message: string): Promise<void> {
    try {
      const job = await this.store.get(jobId)
      if (job) {
        job.progress = [...(job.progress ?? []), { ts: new Date().toISOString(), message }].slice(-200)
        await this.store.save(job)
      }
    } catch { /* progress is best-effort */ }
    this.emitEvent(jobId, { type: 'log', message })
  }

  // ── Settings ────────────────────────────────────────────────────────────────
  //
  // Persisted at {dataDir}/compiler/settings.json — only POINTERS live here
  // (model string + credential NAME); the key itself stays in the encrypted
  // credential store. COMPILER_MODEL env wins over the file (deploy override).

  private settingsPath(): string {
    return path.join(this.dataDir, 'compiler', 'settings.json')
  }

  getSettings(): CompilerSettings {
    let stored: Partial<CompilerSettings> = {}
    try {
      stored = JSON.parse(fs.readFileSync(this.settingsPath(), 'utf8')) as Partial<CompilerSettings>
    } catch { /* defaults */ }
    return {
      model: process.env['COMPILER_MODEL'] ?? stored.model ?? this.defaultModel,
      ...(stored.credentialName ? { credentialName: stored.credentialName } : {}),
    }
  }

  async saveSettings(settings: CompilerSettings): Promise<void> {
    if (!/^[^:]+:.+$/.test(settings.model)) {
      throw new Error(`Invalid model "${settings.model}" — expected 'provider:model'`)
    }
    await fs.promises.mkdir(path.dirname(this.settingsPath()), { recursive: true })
    await fs.promises.writeFile(this.settingsPath(), JSON.stringify({
      model: settings.model,
      ...(settings.credentialName ? { credentialName: settings.credentialName } : {}),
    }, null, 1), 'utf8')
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  listJobs(): Promise<CompileJob[]> { return this.store.list() }
  getJob(id: string): Promise<CompileJob | undefined> { return this.store.get(id) }
  deleteJob(id: string): Promise<void> { return this.store.delete(id) }

  // ── Pipeline ────────────────────────────────────────────────────────────────

  /** Create a job and start analysis in the background. Returns immediately. */
  async createJob(description: string, target: CompileTarget = 'auto'): Promise<CompileJob> {
    const now = new Date().toISOString()
    const job: CompileJob = {
      id: `cj_${randomUUID().slice(0, 8)}`,
      description,
      target,
      status: 'analyzing',
      versions: [],
      messages: [{ role: 'user', content: description, ts: now }],
      createdAt: now,
      updatedAt: now,
    }
    await this.store.save(job)
    void this.guard(job.id, () => this.analyze(job.id))
    return job
  }

  /** User confirms (or corrects) the analysis → codegen + validation. */
  async confirmAnalysis(jobId: string, note?: string): Promise<void> {
    const job = await this.mustGet(jobId, ['awaiting_confirmation', 'failed'])
    if (note) job.messages.push({ role: 'user', content: note, ts: new Date().toISOString() })
    await this.transition(job, 'generating')
    void this.guard(jobId, () => this.generate(jobId, note))
  }

  /**
   * Conversational refinement of the current draft. Registration is not an
   * end state — an approved job keeps taking feedback; the new version lands
   * as a draft that must be approved (re-registered) again.
   */
  async sendMessage(jobId: string, feedback: string): Promise<void> {
    const job = await this.mustGet(jobId, ['draft', 'failed', 'approved'])
    job.messages.push({ role: 'user', content: feedback, ts: new Date().toISOString() })
    await this.transition(job, 'generating')
    void this.guard(jobId, () => this.refine(jobId, feedback))
  }

  /** User edited draft code directly → re-validate as a new version. */
  async updateCode(jobId: string, files: DraftFile[]): Promise<void> {
    for (const f of files) draftFileSchema.parse(f)
    const job = await this.mustGet(jobId, ['draft', 'failed', 'approved'])
    await this.transition(job, 'validating')
    void this.guard(jobId, () => this.validateAndRecord(jobId, { files, explanation: 'Manual edit by user.' }, 'manual-edit', false))
  }

  private async guard(jobId: string, fn: () => Promise<void>): Promise<void> {
    if (this.running.has(jobId)) throw new Error(`Job ${jobId} is already running`)
    this.running.add(jobId)
    try {
      await fn()
    } catch (err) {
      const message = describeError(err)
      const job = await this.store.get(jobId)
      if (job) {
        job.status = 'failed'
        job.error = message
        job.updatedAt = new Date().toISOString()
        await this.store.save(job)
      }
      this.emitEvent(jobId, { type: 'error', message })
    } finally {
      this.running.delete(jobId)
    }
  }

  private async analyze(jobId: string): Promise<void> {
    this.emitEvent(jobId, { type: 'status', status: 'analyzing' })
    const job = await this.mustGet(jobId)
    const settings = this.getSettings()
    await this.progress(jobId, `Analyzer started (${settings.model}${settings.credentialName ? ` · ${settings.credentialName}` : ''})`)
    const analysis = await runAnalyzer(this.agentContext(jobId), job.description, this.maxAnalyzerSteps, job.target ?? 'auto')
    const fresh = await this.mustGet(jobId)
    fresh.analysis = analysis
    await this.transition(fresh, 'awaiting_confirmation')
    this.emitEvent(jobId, { type: 'analysis', message: analysis.summary })
  }

  private async generate(jobId: string, note?: string): Promise<void> {
    this.emitEvent(jobId, { type: 'status', status: 'generating' })
    const job = await this.mustGet(jobId)
    if (!job.analysis) throw new Error('No analysis to generate from')
    const output = await runCodegen(this.agentContext(jobId), job.description, job.analysis, note)
    await this.validateAndRecord(jobId, output, 'initial', true)
  }

  private async refine(jobId: string, feedback: string): Promise<void> {
    this.emitEvent(jobId, { type: 'status', status: 'generating' })
    const job = await this.mustGet(jobId)
    const current = job.versions.at(-1)
    if (!current) throw new Error('No draft to refine')
    const output = await runRefiner(this.agentContext(jobId), job.description, current.files, feedback)
    await this.validateAndRecord(jobId, output, feedback, true)
  }

  /** Validation ladder with fixer rounds; records the final version either way. */
  private async validateAndRecord(jobId: string, output: CodegenOutput, origin: string, allowFix: boolean): Promise<void> {
    let { files, explanation } = output
    const workDir = path.join(this.store.jobDir(jobId), 'work')

    let job = await this.mustGet(jobId)
    await this.transition(job, 'validating')

    await this.progress(jobId, 'Running validation ladder (L1 syntax → L2 types → L3 registration → L4 dry-run)')
    let report = await validateDraft(this.deps.runtime, workDir, files, this.dryRunTimeoutMs, this.deps.credentialStore)
    let rounds = 0
    while (!report.passed && allowFix && rounds < this.maxFixRounds) {
      rounds++
      await this.progress(jobId, `Validation failed (${report.issues.length} issues: ${report.issues.slice(0, 2).map(i => i.level).join(', ')}…) — fixer round ${rounds}/${this.maxFixRounds}`)
      const fixed = await runFixer(this.agentContext(jobId), files, report.issues)
      files = fixed.files
      explanation = `${fixed.explanation}\n\n---\n${explanation}`
      await this.progress(jobId, 'Re-running validation ladder')
      report = await validateDraft(this.deps.runtime, workDir, files, this.dryRunTimeoutMs, this.deps.credentialStore)
    }

    job = await this.mustGet(jobId)
    const version: DraftVersion = {
      seq: (job.versions.at(-1)?.seq ?? 0) + 1,
      files,
      explanation,
      validation: report,
      origin,
      createdAt: new Date().toISOString(),
    }
    job.versions.push(version)
    job.messages.push({ role: 'assistant', content: explanation, ts: version.createdAt })
    if (report.passed) delete job.error   // stale failure banners end here
    await this.transition(job, report.passed ? 'draft' : 'failed')
    if (!report.passed) {
      job.error = `Validation failed after ${rounds} fix rounds: ${report.issues.map(i => i.message).join(' | ')}`
      await this.store.save(job)
    }
    this.emitEvent(jobId, { type: 'draft', message: report.passed ? 'draft ready' : 'draft failed validation' })
  }

  // ── Approval ────────────────────────────────────────────────────────────────

  /**
   * Register the latest validated draft through CompiledLoader. `idOverrides`
   * lets the user rename artifacts before registration. Generated executors
   * REQUIRE `acknowledgeExecutorRisk` — the caller confirmed the red warning
   * (first-run mock/testnet choice happens at instance binding; the user may
   * explicitly go straight to mainnet).
   */
  async approve(jobId: string, options?: { idOverrides?: Record<string, string>; acknowledgeExecutorRisk?: boolean }): Promise<{ registered: Array<{ kind: string; id: string }> }> {
    const job = await this.mustGet(jobId, ['draft'])
    const version = job.versions.at(-1)
    if (!version?.validation?.passed) throw new Error('Latest draft has not passed validation')

    const hasGeneratedExecutor = version.files.some(f => f.kind === 'executors')
    if (hasGeneratedExecutor && !options?.acknowledgeExecutorRisk) {
      throw new Error('Draft contains a generated EXECUTOR (write-capable). Approve requires acknowledgeExecutorRisk: true')
    }

    const registered: Array<{ kind: string; id: string }> = []
    // Strategies register last so their monitor/executor references resolve.
    const ordered = [...version.files].sort((a, b) =>
      (a.kind === 'strategies' ? 1 : 0) - (b.kind === 'strategies' ? 1 : 0))

    for (const file of ordered) {
      const id = options?.idOverrides?.[`${file.kind}/${file.id}`] ?? file.id
      const sourcePath = getCompiledSourcePath(this.dataDir, file.kind, id)
      await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true })
      await fs.promises.writeFile(sourcePath, file.code, 'utf8')
      await this.deps.compiledLoader.recompile(id, file.kind)
      registered.push({ kind: file.kind, id })
    }

    job.status = 'approved'
    job.updatedAt = new Date().toISOString()
    await this.store.save(job)
    this.emitEvent(jobId, { type: 'status', status: 'approved', message: registered.map(r => `${r.kind}/${r.id}`).join(', ') })
    return { registered }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async mustGet(jobId: string, allowedStatuses?: JobStatus[]): Promise<CompileJob> {
    const job = await this.store.get(jobId)
    if (!job) throw new Error(`Unknown compile job "${jobId}"`)
    if (allowedStatuses && !allowedStatuses.includes(job.status)) {
      throw new Error(`Job "${jobId}" is ${job.status} — expected ${allowedStatuses.join('/')}`)
    }
    return job
  }

  private async transition(job: CompileJob, status: JobStatus): Promise<void> {
    job.status = status
    job.updatedAt = new Date().toISOString()
    await this.store.save(job)
    this.emitEvent(job.id, { type: 'status', status })
  }
}
