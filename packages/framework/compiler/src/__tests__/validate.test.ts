import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { OpenWhaleRuntime, BaseExecutor, BaseMonitor, MonitorMode } from '@openwhaleorg/core'
import type { ExecutionInstruction, ExecutionResult } from '@openwhaleorg/core'
import { validateDraft } from '../validate.js'
import type { DraftFile } from '../types.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'owc-validate-'))
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

// ── Test doubles registered into a real runtime ───────────────────────────────

class FakeSession {
  async price(): Promise<number> { return 100 }
  async close(): Promise<void> {}
}

class SigMonitor extends BaseMonitor<string, { value: number }> {
  override readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'sig' }
  override get emitSchema() { return z.object({ value: z.number() }) }
  protected override startSubscribe(): void {}
  protected override stopSubscribe(): void {}
}

class NoopExecutor extends BaseExecutor {
  get executorName() { return 'exec' }
  get supportedActions() { return ['noop'] }
  override get actionSchemas() { return { noop: z.object({ symbol: z.string() }) } }
  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult<ExecutionInstruction>> {
    return { instruction, status: 'success', executedAt: new Date() }
  }
}

function setupRuntime(): OpenWhaleRuntime {
  const runtime = new OpenWhaleRuntime({
    dataDir: tmpDir,
    // loadPlugin needs a store; validation never reads credentials
    credentialStore: {
      set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
      getByName: async () => { throw new Error('no credentials in validate tests') },
      delete: async () => undefined,
      list: async () => [],
    },
  })
  const now = new Date().toISOString()
  // Derived kind vocabulary: the mock adapter cell + the kind-generic account
  // implementation together define 'test/fake' (and power the dry-run reader)
  runtime.loadPlugin(() => ({
    name: 'test', version: '0.0.0', monitors: [], executors: [], strategies: [],
    adapters: [{ kind: 'test/fake', type: 'mock', create: () => new FakeSession() }],
    accounts: [{
      id: 'fake-account', kind: 'test/fake',
      createReader: (session, name) => ({ name, price: () => (session as FakeSession).price() }),
    }],
  }), {})
  runtime.registerMonitor({ id: 'test/sig', name: 'Sig', source: 'builtin', createdAt: now, updatedAt: now }, new SigMonitor())
  runtime.registerExecutor(
    { id: 'test/exec', name: 'Exec', source: 'builtin', supportedActions: ['noop'], createdAt: now, updatedAt: now },
    new NoopExecutor(),
  )
  return runtime
}

// A well-formed generated strategy: local Reader class with a static kind,
// full registry keys, cron trigger, one instruction matching actionSchemas.
const GOOD_STRATEGY = `
import { BaseStrategy } from '@openwhaleorg/core'
import type { StrategyContext, StrategyParams, Trigger, StrategyDeclarations, ExecutionInstruction } from '@openwhaleorg/core'
import { z } from 'zod'

class FakeReader {
  static readonly kind = 'test/fake' as const
  constructor(readonly name: string) {}
  price!: () => Promise<number>
}

const decls = {
  monitors: [{ name: 'test/sig', label: 'sig' }],
  executors: [{ name: 'test/exec', label: 'exec' }],
  accounts: [{ account: FakeReader, label: 'main' }],
} as const satisfies StrategyDeclarations

export default class GeneratedStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'generated'
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts

  readonly baseParamsSchema = z.object({ symbol: z.string() })
  readonly tunableParamsSchema = z.object({ threshold: z.number().default(1) })

  triggers(_params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return [{ enabled: true, conditions: [{ type: 'cron', expression: '* * * * *' }] }]
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const { symbol } = this.baseParamsSchema.parse(this.params.base)
    const data = context.getData('sig', 'any') as { value: number } | undefined
    if (!data || data.value < 0) return []
    return [this.instruction('exec', 'noop', { symbol }, ['main'])]
  }
}
`

function draft(code: string): DraftFile[] {
  return [{ kind: 'strategies', id: 'generated', code }]
}

function work(name: string): string {
  return path.join(tmpDir, `work-${name}`)
}

describe('validation ladder', () => {
  it('passes a well-formed strategy and captures its dry-run instruction', async () => {
    const report = await validateDraft(setupRuntime(), work('good'), draft(GOOD_STRATEGY), 15_000)
    expect(report.issues).toEqual([])
    expect(report.passed).toBe(true)
    expect(report.dryRunInstructions).toEqual([
      { executorLabel: 'exec', action: 'noop', params: { symbol: 'BTC/USDC:USDC' } },
    ])
  }, 60_000)

  it('L1: rejects disallowed imports', async () => {
    const code = `import ccxt from 'ccxt'\n${GOOD_STRATEGY}`
    const report = await validateDraft(setupRuntime(), work('imports'), draft(code), 15_000)
    expect(report.passed).toBe(false)
    expect(report.issues.some(i => i.level === 'L1-syntax' && i.message.includes('"ccxt" is not allowed'))).toBe(true)
  })

  it('L2: rejects type errors (label typo dies in tsc)', async () => {
    const code = GOOD_STRATEGY.replace("this.instruction('exec'", "this.instruction('exce'")
    const report = await validateDraft(setupRuntime(), work('types'), draft(code), 15_000)
    expect(report.passed).toBe(false)
    expect(report.issues.some(i => i.level === 'L2-types')).toBe(true)
  }, 60_000)

  it('L3: rejects references to unregistered components', async () => {
    const code = GOOD_STRATEGY.replaceAll('test/exec', 'test/nonexistent')
    const report = await validateDraft(setupRuntime(), work('reg'), draft(code), 15_000)
    expect(report.passed).toBe(false)
    expect(report.issues.some(i => i.level === 'L3-registration' && i.message.includes('test/nonexistent'))).toBe(true)
  }, 60_000)

  it('L4: rejects instruction params violating the executor actionSchemas', async () => {
    const code = GOOD_STRATEGY.replace(
      "this.instruction('exec', 'noop', { symbol }, ['main'])",
      "this.instruction('exec', 'noop', { symbol: 42 as unknown as string }, ['main'])",
    )
    const report = await validateDraft(setupRuntime(), work('dryrun'), draft(code), 15_000)
    expect(report.passed).toBe(false)
    expect(report.issues.some(i => i.level === 'L4-dryrun' && i.message.includes('params invalid'))).toBe(true)
  }, 60_000)
})
