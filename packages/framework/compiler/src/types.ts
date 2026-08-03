import { z } from 'zod'

/** One generated source file. `kind` maps to CompiledLoader's type dirs. */
export const draftFileSchema = z.object({
  kind: z.enum(['strategies', 'monitors', 'executors']),
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i),
  code: z.string(),
})
export type DraftFile = z.infer<typeof draftFileSchema>

/** Analyzer output — shown to the user for confirmation before codegen. */
export const analysisSchema = z.object({
  summary: z.string().describe('Core strategy logic in 2-4 sentences, in the user\'s language'),
  reuse: z.object({
    monitors: z.array(z.object({ id: z.string(), label: z.string(), reason: z.string() })),
    executors: z.array(z.object({ id: z.string(), label: z.string(), actions: z.array(z.string()), reason: z.string() })),
    accounts: z.array(z.object({ readerClass: z.string(), importFrom: z.string(), label: z.string(), kind: z.string() })),
  }),
  generate: z.object({
    strategy: z.object({ id: z.string(), name: z.string(), description: z.string() }).optional()
      .describe('Omit when the compile target is a standalone monitor/executor'),
    monitors: z.array(z.object({ id: z.string(), purpose: z.string(), justification: z.string() })),
    executors: z.array(z.object({ id: z.string(), purpose: z.string(), justification: z.string() })),
  }),
  triggers: z.string().describe('Trigger plan: cron expression and/or monitor conditions'),
  params: z.string().describe('Planned base/tunable params'),
  gaps: z.array(z.string()).describe('Capability gaps that block or degrade the strategy — empty when none'),
})
export type StrategyAnalysis = z.infer<typeof analysisSchema>

export const codegenOutputSchema = z.object({
  files: z.array(draftFileSchema).min(1),
  explanation: z.string().describe('What the code does, key decisions, param meanings, risk notes — required every round'),
})
export type CodegenOutput = z.infer<typeof codegenOutputSchema>

export type ValidationLevel = 'L1-syntax' | 'L2-types' | 'L3-registration' | 'L4-dryrun'

export interface ValidationIssue {
  level: ValidationLevel
  file?: string
  message: string
}

export interface ValidationReport {
  passed: boolean
  issues: ValidationIssue[]
  /** Instructions captured during the L4 dry-run (informational). */
  dryRunInstructions?: Array<{ executorLabel: string; action: string; params: Record<string, unknown> }>
}

export interface DraftVersion {
  seq: number
  files: DraftFile[]
  explanation: string
  validation?: ValidationReport
  /** What prompted this version: 'initial' | user feedback text | 'manual-edit' | fixer round. */
  origin: string
  createdAt: string
}

export type JobStatus =
  | 'analyzing'
  | 'awaiting_confirmation'   // analysis ready, waiting for user confirm/correct
  | 'generating'
  | 'validating'
  | 'draft'                   // validated draft awaiting review / iteration
  | 'failed'
  | 'approved'

/** What the job is asked to produce. 'auto' lets the analyzer decide (defaults to a strategy). */
export type CompileTarget = 'auto' | 'strategy' | 'monitor' | 'executor' | 'suite'

export interface CompileJob {
  id: string
  description: string
  target?: CompileTarget
  status: JobStatus
  analysis?: StrategyAnalysis
  versions: DraftVersion[]
  messages: Array<{ role: 'user' | 'assistant'; content: string; ts: string }>
  /** Live pipeline activity (tool calls, agent steps, fixer rounds). Capped; survives restarts. */
  progress?: Array<{ ts: string; message: string }>
  error?: string
  createdAt: string
  updatedAt: string
}

export interface CompilerEvent {
  jobId: string
  type: 'status' | 'log' | 'analysis' | 'draft' | 'error'
  status?: JobStatus
  message?: string
  ts: number
}

/** Persisted compiler LLM configuration — pointers only, never key material. */
export interface CompilerSettings {
  /** 'provider:model', e.g. 'anthropic:claude-sonnet-5'. */
  model: string
  /** Credential name pin (needed when several credentials of the provider's type exist). */
  credentialName?: string
}

export interface CompilerOptions {
  /** Data dir (defaults to OPENWHALE_DATA_DIR or ~/.openwhale). */
  dataDir?: string
  /** 'provider:model' for analyzer/codegen/fixer. Default 'anthropic:claude-sonnet-5'. */
  model?: string
  /** Max fixer rounds per validation ladder run. Default 4. */
  maxFixRounds?: number
  /** Max analyzer agent steps. Default 24. */
  maxAnalyzerSteps?: number
  /** Dry-run timeout in ms. Default 15000. */
  dryRunTimeoutMs?: number
}
