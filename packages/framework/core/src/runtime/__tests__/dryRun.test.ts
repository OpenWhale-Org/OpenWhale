import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import { BaseStrategy } from '../../strategy/BaseStrategy.js'
import { BaseExecutor } from '../../executor/BaseExecutor.js'
import { BaseMonitor, MonitorMode } from '../../monitor/BaseMonitor.js'
import { MemoryExecutionQueue } from '../../executor/MemoryExecutionQueue.js'
import type { StrategyContext } from '../../types/strategy.js'
import type { Trigger } from '../../types/trigger.js'
import type { ExecutionInstruction, ExecutionResult } from '../../types/executor.js'
import type { CredentialStore } from '../../types/credential.js'
import { getExecutionPath } from '../../utils/paths.js'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'

/**
 * Framework dry run.
 *
 * The claim under test is a negative one — that the executor NEVER RUNS — so
 * the executor counts its own calls and the assertion is on that count, not on
 * a status string. A dry run that still reached the venue would satisfy every
 * check about labels and records while placing real orders.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-dryrun-'))

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async () => ({ type: 'test', data: {} }),
  delete: async () => undefined,
  list: async () => [],
}

class SignalMonitor extends BaseMonitor<string, { go: boolean }> {
  override readonly mode = MonitorMode.Standalone
  get monitorName() { return 'signal' }
  protected override startStandalone(): void {}
  protected override stopStandalone(): void {}
  protected override async append(): Promise<void> {}
  async fire(key: string) { await this.push(key, { go: true }) }
}

/** Counts every call. In dry run this must stay at zero. */
class CountingExecutor extends BaseExecutor {
  calls = 0
  constructor() { super({ dataDir: tmpDir }) }
  get executorName() { return 'trade' }
  get supportedActions() { return ['buy'] }
  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult> {
    this.calls++
    return { instruction, status: 'success', data: { orderId: 'o1', symbol: 'BTC' }, executedAt: new Date() }
  }
}

const decls = {
  monitors: [{ name: 'signal', label: 'sig' }],
  executors: [{ name: 'trade', label: 'exec' }],
} as const

class Buyer extends BaseStrategy<typeof decls> {
  readonly strategyId = 'buyer'
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly baseParamsSchema = z.object({ size: z.number().default(1) })

  triggers(): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return [{ enabled: true, conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('sig'), key: 'tick' }] }] }]
  }

  async evaluate(_ctx: StrategyContext): Promise<ExecutionInstruction[]> {
    return [this.instruction('exec', 'buy', { symbol: 'BTC', size: this.baseParamsSchema.parse(this.params.base).size })]
  }
}

async function settle(ms = 150) { await new Promise(r => setTimeout(r, ms)) }

function records(instanceId: string): Array<{ status: string; instruction: { instanceId?: string; action: string } }> {
  const file = getExecutionPath(tmpDir, 'trade')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => JSON.parse(l) as { status: string; instruction: { instanceId?: string; action: string } })
    .filter(r => r.instruction.instanceId === instanceId)
}

describe('framework dry run', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('records the instruction and never reaches the executor, and the switch works while live', async () => {
    const monitor = new SignalMonitor()
    const executor = new CountingExecutor()
    const database = new SQLiteAdapter({ filePath: path.join(tmpDir, 'test.db') })
    await database.initialize()
    const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, database, queue: new MemoryExecutionQueue() })
    const now = new Date().toISOString()
    runtime.registerMonitor({ id: 'signal', name: 'Signal', source: 'builtin', createdAt: now, updatedAt: now }, monitor)
    runtime.registerExecutor(
      { id: 'trade', name: 'Trade', source: 'builtin', supportedActions: ['buy'], createdAt: now, updatedAt: now },
      executor,
    )
    runtime.registerStrategy({ id: 'buyer', name: 'Buyer', source: 'builtin', createdAt: now, updatedAt: now }, () => new Buyer())
    await runtime.start()

    const seen: ExecutionResult[] = []
    runtime.onExecution(r => { seen.push(r) })

    const base = { credentials: {}, enabled: true, createdAt: now, updatedAt: now, strategyId: 'buyer' }
    await runtime.activate({ ...base, id: 'i-dry', name: 'dry', params: { base: {}, tunable: {} }, options: { dryRun: true } })
    await runtime.activate({ ...base, id: 'i-live', name: 'live', params: { base: {}, tunable: {} } })

    await monitor.fire('tick')
    await settle()

    // The live instance reached the executor; the dry one did not. One call,
    // not two — this is the assertion the whole feature exists for.
    expect(executor.calls).toBe(1)

    const dry = records('i-dry')
    expect(dry).toHaveLength(1)
    expect(dry[0]!.status).toBe('dry-run')
    expect(dry[0]!.instruction.action).toBe('buy')
    expect(records('i-live').map(r => r.status)).toEqual(['success'])

    // Listeners see both kinds, so an operator watching "what would this have
    // done" is served by the same subscription that carries real executions.
    expect(seen.filter(r => r.instruction.instanceId === 'i-dry').map(r => r.status)).toEqual(['dry-run'])
    expect(seen.filter(r => r.instruction.instanceId === 'i-live').map(r => r.status)).toEqual(['success'])

    // Turned OFF on the running instance: the next trigger reaches the executor
    // without a restart.
    await runtime.updateInstanceMeta('i-dry', { options: { dryRun: false } })
    await monitor.fire('tick')
    await settle()
    expect(executor.calls).toBe(3)
    expect(records('i-dry').map(r => r.status)).toEqual(['dry-run', 'success'])

    // And back ON, live.
    await runtime.updateInstanceMeta('i-dry', { options: { dryRun: true } })
    await monitor.fire('tick')
    await settle()
    expect(executor.calls).toBe(4)   // only the live instance
    expect(records('i-dry').map(r => r.status)).toEqual(['dry-run', 'success', 'dry-run'])

    await runtime.stop()
  })

  it('survives a restart with the switch still on', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-dryrun2-'))
    const database = new SQLiteAdapter({ filePath: path.join(dir, 'test.db') })
    await database.initialize()
    const monitor = new SignalMonitor()
    const executor = new CountingExecutor()
    const now = new Date().toISOString()

    const build = () => {
      const rt = new OpenWhaleRuntime({ dataDir: dir, credentialStore, database, queue: new MemoryExecutionQueue() })
      rt.registerMonitor({ id: 'signal', name: 'Signal', source: 'builtin', createdAt: now, updatedAt: now }, monitor)
      rt.registerExecutor({ id: 'trade', name: 'Trade', source: 'builtin', supportedActions: ['buy'], createdAt: now, updatedAt: now }, executor)
      rt.registerStrategy({ id: 'buyer', name: 'Buyer', source: 'builtin', createdAt: now, updatedAt: now }, () => new Buyer())
      return rt
    }

    const first = build()
    await first.start()
    await first.activate({
      id: 'i-persist', name: 'persist', strategyId: 'buyer', credentials: {}, enabled: true,
      createdAt: now, updatedAt: now, params: { base: {}, tunable: {} }, options: { dryRun: true },
    })
    await first.stop()

    // A fresh runtime over the same database restores the instance — and with
    // it the switch. A dry run that quietly ends at the next restart is the
    // failure mode that costs money.
    executor.calls = 0
    const second = build()
    await second.start()
    await settle()
    await monitor.fire('tick')
    await settle()
    expect(executor.calls).toBe(0)
    await second.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
