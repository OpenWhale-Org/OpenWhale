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
import type { StrategyContext, LifecycleContext } from '../../types/strategy.js'
import type { Trigger } from '../../types/trigger.js'
import type { ExecutionInstruction, ExecutionResult } from '../../types/executor.js'
import type { CredentialStore } from '../../types/credential.js'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'

/**
 * A strategy's two moments of its own. The one that matters most is the last:
 * a resting quote cancelled at deactivation has to be cancelled by executor
 * slots that are about to be removed, after the run in flight has finished,
 * and a hook that fails must not leave the instance running.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-lifecycle-'))
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

class RecordingExecutor extends BaseExecutor {
  actions: string[] = []
  /** Instances whose slots the runtime has already removed. */
  released = new Set<string>()
  constructor() { super({ dataDir: tmpDir }) }
  get executorName() { return 'trade' }
  get supportedActions() { return ['buy', 'cancel', 'setLeverage'] }
  override removeMaterialized(instanceId: string): void { this.released.add(instanceId); super.removeMaterialized(instanceId) }
  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult> {
    // The cancel must arrive BEFORE this instance's slots are removed.
    this.actions.push(`${instruction.action}${this.released.has(instruction.instanceId ?? '') ? ':after-release' : ''}`)
    return { instruction, status: 'success', data: {}, executedAt: new Date() }
  }
}

const decls = {
  monitors: [{ name: 'signal', label: 'sig' }],
  executors: [{ name: 'trade', label: 'exec' }],
} as const

/** Records lifecycle calls on a shared log, keyed by instance. */
const calls: Record<string, string[]> = {}
let slowRunMs = 0
let failActivate = false
let throwOnDeactivate = false

class Quoter extends BaseStrategy<typeof decls> {
  readonly strategyId = 'quoter'
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly baseParamsSchema = z.object({ size: z.number().default(1) })
  triggers(): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    return [{ enabled: true, conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('sig'), key: 'tick' }] }] }]
  }
  override async onActivate(ctx: LifecycleContext): Promise<ExecutionInstruction[]> {
    ;(calls[ctx.instanceId] ??= []).push(`activate:${ctx.reason}`)
    // A rollback re-activates the previous configuration; it must not be the one refusing.
    if (failActivate && ctx.reason !== 'rollback') throw new Error('refusing to start')
    this.trace('leverage', { leverage: 3 })
    return [this.instruction('exec', 'setLeverage', { symbol: 'BTC', leverage: 3 })]
  }
  override async onDeactivate(ctx: LifecycleContext): Promise<ExecutionInstruction[]> {
    ;(calls[ctx.instanceId] ??= []).push(`deactivate:${ctx.reason}`)
    if (throwOnDeactivate) throw new Error('hook blew up')
    return [this.instruction('exec', 'cancel', { orderId: 'q1', symbol: 'BTC' })]
  }
  async evaluate(_ctx: StrategyContext): Promise<ExecutionInstruction[]> {
    if (slowRunMs > 0) await new Promise(r => setTimeout(r, slowRunMs))
    return [this.instruction('exec', 'buy', { symbol: 'BTC' })]
  }
}

async function settle(ms = 150) { await new Promise(r => setTimeout(r, ms)) }

/**
 * Wait for a condition, not for a duration.
 *
 * A fixed sleep is a bet that the machine is idle, and during a full-suite run
 * it is not: 150ms was enough on its own and failed about one run in two under
 * load. Poll instead, and let the deadline be generous — a passing test costs
 * one tick, only a genuinely broken one waits.
 */
async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
}

async function harness(quiesceTimeoutMs?: number) {
  const monitor = new SignalMonitor()
  const executor = new RecordingExecutor()
  const database = new SQLiteAdapter({ filePath: path.join(tmpDir, `${Math.random().toString(36).slice(2)}.db`) })
  await database.initialize()
  const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, database, queue: new MemoryExecutionQueue(), ...(quiesceTimeoutMs !== undefined ? { quiesceTimeoutMs } : {}) })
  const now = new Date().toISOString()
  runtime.registerMonitor({ id: 'signal', name: 'Signal', source: 'builtin', createdAt: now, updatedAt: now }, monitor)
  runtime.registerExecutor({ id: 'trade', name: 'Trade', source: 'builtin', supportedActions: ['buy', 'cancel', 'setLeverage'], createdAt: now, updatedAt: now }, executor)
  runtime.registerStrategy({ id: 'quoter', name: 'Quoter', source: 'builtin', createdAt: now, updatedAt: now }, () => new Quoter())
  await runtime.start()
  const instance = (id: string, options?: { dryRun?: boolean }) => ({
    id, name: id, strategyId: 'quoter', credentials: {}, enabled: true, createdAt: now, updatedAt: now,
    params: { base: {}, tunable: {} }, ...(options ? { options } : {}),
  })
  return { runtime, monitor, executor, instance }
}

describe('lifecycle hooks', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('onActivate runs after wiring and its instructions are fired before the first trigger', async () => {
    const { runtime, monitor, executor, instance } = await harness()
    await runtime.activate(instance('a1'))
    expect(calls['a1']).toEqual(['activate:activate'])
    expect(executor.actions).toEqual(['setLeverage'])
    await monitor.fire('tick')
    await settle()
    expect(executor.actions).toEqual(['setLeverage', 'buy'])
    // The activation is on the instance board as a run of its own.
    const runs = (runtime.getStrategy('a1') as Quoter).getRecentRuns()
    expect(runs.map(r => r.triggerId)).toContain('lifecycle:activate')
    expect(runs.find(r => r.triggerId === 'lifecycle:activate')!.steps.some(s => s.step === 'leverage')).toBe(true)
    await runtime.stop()
  })

  it('onDeactivate fires its cancel while the executor slots still exist', async () => {
    const { runtime, executor, instance } = await harness()
    await runtime.activate(instance('d1'))
    await runtime.deactivate('d1')
    expect(calls['d1']).toEqual(['activate:activate', 'deactivate:stop'])
    // 'cancel', not 'cancel:unmaterialized' — the slots were there.
    expect(executor.actions).toEqual(['setLeverage', 'cancel'])
    expect(executor.released.has('d1')).toBe(true)
    await runtime.stop()
  })

  it('names the transition: restart, rollback, delete, shutdown', async () => {
    failActivate = false
    const { runtime, instance } = await harness()
    await runtime.activate(instance('r1'))
    await runtime.updateInstance('r1', { name: 'renamed' }, { restart: true })
    expect(calls['r1']).toEqual(['activate:activate', 'deactivate:restart', 'activate:restart'])

    // A restart whose activation fails brings the previous configuration back.
    failActivate = true
    await expect(runtime.updateInstance('r1', { name: 'again' }, { restart: true })).rejects.toThrow(/rolled back/)
    failActivate = false
    expect(calls['r1']!.slice(3)).toEqual(['deactivate:restart', 'activate:restart', 'deactivate:stop', 'activate:rollback'])

    await runtime.activate(instance('r2'))
    await runtime.deleteInstance('r2')
    expect(calls['r2']).toEqual(['activate:activate', 'deactivate:delete'])

    await runtime.activate(instance('r3'))
    await runtime.stop()
    expect(calls['r3']!.at(-1)).toBe('deactivate:shutdown')
  })

  it('a failing onActivate fails the activation and leaves nothing running', async () => {
    failActivate = true
    const { runtime, executor, instance } = await harness()
    await expect(runtime.activate(instance('f1'))).rejects.toThrow(/refusing to start/)
    failActivate = false
    expect(runtime.listInstances().map(i => i.id)).not.toContain('f1')
    expect(executor.released.has('f1')).toBe(true)
    await runtime.stop()
  })

  it('a failing onDeactivate never blocks the stop', async () => {
    throwOnDeactivate = true
    const { runtime, executor, instance } = await harness()
    await runtime.activate(instance('f2'))
    await runtime.deactivate('f2')
    throwOnDeactivate = false
    expect(runtime.listInstances().map(i => i.id)).not.toContain('f2')
    expect(executor.released.has('f2')).toBe(true)
    await runtime.stop()
  })

  it('waits for the run in flight before the deactivate hook, and no new run starts', async () => {
    slowRunMs = 300
    const { runtime, monitor, executor, instance } = await harness()
    await runtime.activate(instance('w1'))
    await monitor.fire('tick')
    await settle(50)                       // the run is now mid-evaluate
    const stopping = runtime.deactivate('w1')
    await monitor.fire('tick')             // must not start another run
    await stopping
    slowRunMs = 0
    // buy (the run that was in flight), then cancel — never cancel before buy.
    expect(executor.actions).toEqual(['setLeverage', 'buy', 'cancel'])
    await runtime.stop()
  })

  it('in dry run, hook instructions are recorded and not fired', async () => {
    const { runtime, executor, instance } = await harness()
    const seen: ExecutionResult[] = []
    runtime.onExecution(r => { seen.push(r) })
    await runtime.activate(instance('dry', { dryRun: true }))
    await runtime.deactivate('dry')
    // Dry-run records are written and announced asynchronously, as a run's are.
    await until(() => seen.filter(r => r.instruction.instanceId === 'dry').length >= 2)
    expect(executor.actions).toEqual([])
    expect(seen.filter(r => r.instruction.instanceId === 'dry').map(r => [r.instruction.action, r.status]))
      .toEqual([['setLeverage', 'dry-run'], ['cancel', 'dry-run']])
    await runtime.stop()
  })
})
