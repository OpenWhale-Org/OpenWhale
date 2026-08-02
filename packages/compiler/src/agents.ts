import { tool } from 'ai'
import { z } from 'zod'
import type { OpenWhaleRuntime, LlmClient, CredentialStore } from '@openwhaleorg/core'
import { FRAMEWORK_GUIDE } from './guide.js'
import { snapshot, readComponentSource } from './introspect.js'
import { analysisSchema, codegenOutputSchema } from './types.js'
import type { StrategyAnalysis, CodegenOutput, DraftFile, ValidationIssue } from './types.js'

export interface AgentContext {
  runtime: OpenWhaleRuntime
  llm: LlmClient
  credentials: CredentialStore
  model: string
  /** Pin a specific LLM credential (when several of the provider's type exist). */
  credentialName?: string
  log: (message: string) => void
}

function systemPrompt(runtime: OpenWhaleRuntime): string {
  return `${FRAMEWORK_GUIDE}\n\n# Registered components (the ONLY reusable ids)\n${JSON.stringify(snapshot(runtime), null, 1)}`
}

/**
 * Analyzer: agentic loop that may read component sources before deciding
 * reuse vs generate, and must finish by calling submit_analysis.
 */
const TARGET_DIRECTIVES: Record<string, string> = {
  auto: 'Decide the deliverable from the description; the default deliverable is a STRATEGY.',
  strategy: 'The deliverable is a STRATEGY (plus supporting monitors/executors only when unavoidable).',
  monitor: 'The deliverable is a standalone MONITOR — do NOT generate a strategy (omit generate.strategy). Declare emitSchema and keySchema.',
  executor: 'The deliverable is a standalone EXECUTOR — do NOT generate a strategy (omit generate.strategy). Declare actionSchemas and credential slots using EXISTING kinds.',
  suite: 'The deliverable is a FULL SUITE: a strategy plus the monitors/executors it needs, generated together with consistent ids.',
}

export async function runAnalyzer(
  ctx: AgentContext,
  description: string,
  maxSteps: number,
  target: string = 'auto',
): Promise<StrategyAnalysis> {
  let captured: StrategyAnalysis | undefined

  const tools = {
    read_component_source: tool({
      description: 'Read the implementation source of a registered monitor or executor before deciding whether it can be reused.',
      inputSchema: z.object({ type: z.enum(['monitor', 'executor']), id: z.string() }),
      execute: async ({ type, id }) => {
        ctx.log(`analyzer reads ${type} ${id}`)
        return readComponentSource(ctx.runtime, type, id)
      },
    }),
    submit_analysis: tool({
      description: 'Submit the final analysis. Call exactly once, after all reads.',
      inputSchema: analysisSchema,
      execute: async (analysis) => {
        captured = analysis as StrategyAnalysis
        ctx.log('analysis submitted')
        return 'recorded'
      },
    }),
  }

  let stepNo = 0

  await ctx.llm.callWithTools({
    model: ctx.model,
    ...(ctx.credentialName ? { credentialName: ctx.credentialName } : {}),
    system: `${systemPrompt(ctx.runtime)}

# Task
Compile target: ${TARGET_DIRECTIVES[target] ?? TARGET_DIRECTIVES['auto']}
Analyze the user's description. REUSE-FIRST is mandatory: a new
monitor/executor is only justified when you can state precisely why no
registered component covers the need (read their source if unsure). Readers
can NEVER be generated — unmet data needs go into gaps. End by calling
submit_analysis. Write summary/reasons in the user's language.`,
    messages: [{ role: 'user', content: description }],
    tools,
    maxSteps,
    // Live progress: whatever the model wrote or called this step
    onStepFinish: (step) => {
      stepNo++
      const calls = (step.toolCalls ?? []).map(c => {
        const input = c.input as Record<string, unknown> | undefined
        const args = input && (input['id'] ?? input['type']) ? ` ${String(input['type'] ?? '')} ${String(input['id'] ?? '')}`.trimEnd() : ''
        return `${c.toolName}${args ? `(${args.trim()})` : ''}`
      }).join(', ')
      const text = (step.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 160)
      if (calls || text) ctx.log(`step ${stepNo}: ${[text, calls && `→ ${calls}`].filter(Boolean).join(' ')}`)
    },
  }, ctx.credentials)

  if (!captured) throw new Error('Analyzer did not submit an analysis')
  return captured
}

/** Codegen: analysis (+optional user corrections) → files + explanation. */
export async function runCodegen(
  ctx: AgentContext,
  description: string,
  analysis: StrategyAnalysis,
  userNote?: string,
): Promise<CodegenOutput> {
  ctx.log(`codegen started (${[analysis.generate.strategy ? 'strategy' : '', analysis.generate.monitors.length ? `${analysis.generate.monitors.length} monitor(s)` : '', analysis.generate.executors.length ? `${analysis.generate.executors.length} executor(s)` : ''].filter(Boolean).join(' + ') || 'components'})`)
  return await ctx.llm.call({
    model: ctx.model,
    ...(ctx.credentialName ? { credentialName: ctx.credentialName } : {}),
    retry: { maxRetries: 2 },
    schema: codegenOutputSchema,
    messages: [{
      role: 'user',
      content: `${systemPrompt(ctx.runtime)}

# Strategy description
${description}

# Approved analysis (follow it)
${JSON.stringify(analysis, null, 1)}
${userNote ? `\n# User corrections on the analysis\n${userNote}` : ''}

Generate the code now: ${[
  analysis.generate.strategy ? 'one strategies file' : '',
  analysis.generate.monitors.length ? `${analysis.generate.monitors.length} monitor file(s)` : '',
  analysis.generate.executors.length ? `${analysis.generate.executors.length} executor file(s)` : '',
].filter(Boolean).join(' + ') || 'the approved components'}.
The explanation must cover: what the code does, key decisions, every param's
meaning, and risk notes — in the user's language.`,
    }],
  }, ctx.credentials)
}

/** Fixer: validation issues → corrected files + explanation of the fix. */
export async function runFixer(
  ctx: AgentContext,
  files: DraftFile[],
  issues: ValidationIssue[],
): Promise<CodegenOutput> {
  ctx.log('fixer started')
  return await ctx.llm.call({
    model: ctx.model,
    ...(ctx.credentialName ? { credentialName: ctx.credentialName } : {}),
    retry: { maxRetries: 2 },
    schema: codegenOutputSchema,
    messages: [{
      role: 'user',
      content: `${systemPrompt(ctx.runtime)}

# Current draft files
${JSON.stringify(files, null, 1)}

# Validation failures to fix (change as little as possible)
${issues.map(i => `- [${i.level}]${i.file ? ` ${i.file}:` : ''} ${i.message}`).join('\n')}

Return ALL files (changed and unchanged). Explain what you changed and why.`,
    }],
  }, ctx.credentials)
}

/** Refiner: user feedback on a draft → incrementally revised files. */
export async function runRefiner(
  ctx: AgentContext,
  description: string,
  files: DraftFile[],
  feedback: string,
): Promise<CodegenOutput> {
  ctx.log('refiner started (incremental change from feedback)')
  return await ctx.llm.call({
    model: ctx.model,
    ...(ctx.credentialName ? { credentialName: ctx.credentialName } : {}),
    retry: { maxRetries: 2 },
    schema: codegenOutputSchema,
    messages: [{
      role: 'user',
      content: `${systemPrompt(ctx.runtime)}

# Original strategy description
${description}

# Current draft files
${JSON.stringify(files, null, 1)}

# User feedback — apply as an INCREMENTAL change, do not rewrite from scratch
${feedback}

Return ALL files. Explain what changed, why, and any new risks — in the user's language.`,
    }],
  }, ctx.credentials)
}
