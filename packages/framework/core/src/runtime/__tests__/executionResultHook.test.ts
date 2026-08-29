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
 * A strategy learns how its own instruction ended: the executor's recorded
 * result comes back to the originating instance through onExecutionResult,
 * with the instance's store available and a throwing hook contained.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-result-hook-'))

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

class EchoExecutor extends BaseExecutor {
  constructor() { super({ dataDir: tmpDir }) }
  get executorName() { return 'trade' }
  get supportedActions() { return ['noop'] }
  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult> {
    const fail = instruction.params['fail'] === true
    return fail
      ? { instruction, status: 'failed', error: 'venue said no', executedAt: new Date() }
      : { instruction, status: 'success', data: { orderId: `o-${instruction.params['tag']}`, symbol: 'BTC' }, executedAt: new Date() }
  }
}

const decls = {
  monitors: [{ name: 'signal', label: 'sig' }],
  executors: [{ name: 'trade', label: 'exec' }],
} as const

const seen: Array<{ instanceId: string; status: string; tag: unknown; throwing: boolean }> = []

class HookedStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'hooked'
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly baseParamsSchema = z.object({ tag: z.string(), throwing: z.boolean().default(false) })

  triggers(): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return [{ enabled: true, conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('sig'), key: 'tick' }] }] }]
  }

  async evaluate(_ctx: StrategyContext): Promise<ExecutionInstruction[]> {
    const { tag, throwing } = this.baseParamsSchema.parse(this.params.base)
    return [this.instruction('exec', 'noop', { tag, fail: throwing })]
  }

  override async onExecutionResult(result: ExecutionResult, ctx: { instanceId: string }): Promise<void> {
    const { throwing } = this.baseParamsSchema.parse(this.params.base)
    // Outside run(): must be a silent no-op, never a throw
    this.trace('hook', { status: result.status })
    await this.store.set('last', { status: result.status, tag: result.instruction.params['tag'] })
    seen.push({ instanceId: ctx.instanceId, status: result.status, tag: result.instruction.params['tag'], throwing })
    if (throwing) throw new Error('bookkeeping exploded')
  }
}

async function settle(ms = 150) { await new Promise(r => setTimeout(r, ms)) }

describe('onExecutionResult', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('delivers each instance its own instruction results, with the store available', async () => {
    seen.length = 0
    const monitor = new SignalMonitor()
    // A database, so the per-instance store the hook writes to exists
    const database = new SQLiteAdapter({ filePath: path.join(tmpDir, 'test.db') })
    await database.initialize()
    const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, database, queue: new MemoryExecutionQueue() })
    const now = new Date().toISOString()
    runtime.registerMonitor({ id: 'signal', name: 'Signal', source: 'builtin', createdAt: now, updatedAt: now }, monitor)
    runtime.registerExecutor(
      { id: 'trade', name: 'Trade', source: 'builtin', supportedActions: ['noop'], createdAt: now, updatedAt: now },
      new EchoExecutor(),
    )
    runtime.registerStrategy({ id: 'hooked', name: 'Hooked', source: 'builtin', createdAt: now, updatedAt: now }, () => new HookedStrategy())
    await runtime.start()

    const base = { credentials: {}, enabled: true, createdAt: now, updatedAt: now, strategyId: 'hooked' }
    await runtime.activate({ ...base, id: 'i-ok', name: 'ok', params: { base: { tag: 'ok' }, tunable: {} } })
    await runtime.activate({ ...base, id: 'i-boom', name: 'boom', params: { base: { tag: 'boom', throwing: true }, tunable: {} } })

    await monitor.fire('tick')
    await settle()

    // Each instance saw exactly its own instruction — the failed one included
    expect(seen.map(s => [s.instanceId, s.tag, s.status]).sort()).toEqual([
      ['i-boom', 'boom', 'failed'],
      ['i-ok', 'ok', 'success'],
    ])
    const ok = runtime.getStrategy('i-ok') as HookedStrategy
    expect(await ok['store'].get('last')).toEqual({ status: 'success', tag: 'ok' })

    // The throwing hook neither broke the queue nor the next delivery
    await monitor.fire('tick')
    await settle()
    expect(seen.filter(s => s.instanceId === 'i-boom')).toHaveLength(2)
    expect(seen.filter(s => s.instanceId === 'i-ok')).toHaveLength(2)

    // Execution records were written for the throwing instance's instructions too
    const lines = fs.readFileSync(getExecutionPath(tmpDir, 'trade'), 'utf8').trim().split('\n')
    const boomRecords = lines.map(l => JSON.parse(l) as { instruction: { instanceId?: string } })
      .filter(r => r.instruction.instanceId === 'i-boom')
    expect(boomRecords).toHaveLength(2)

    await runtime.stop()
  })
})
