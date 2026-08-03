import { describe, it, expect } from 'vitest'
import { z, type ZodObject, type ZodRawShape } from 'zod'
import { definePlugin } from '../definePlugin.js'
import { OwMonitor, OwAccount, OwExecutor } from '../componentDecorators.js'
import { BaseMonitor, MonitorMode } from '../../monitor/BaseMonitor.js'
import { BaseExecutor } from '../../executor/BaseExecutor.js'
import type { MonitorContext } from '../../types/monitorInstance.js'
import type { ExecutionInstruction, ExecutionResult } from '../../types/executor.js'
import type { NamespacedKind } from '../../types/materialization.js'

@OwMonitor({ id: 'feed', name: 'Feed', credential: { type: 'svc', level: 'optional' } })
class FeedMonitor extends BaseMonitor<string, { v: number }> {
  override readonly mode = MonitorMode.Subscribe
  constructor(readonly ctx: MonitorContext) { super() }
  get monitorName() { return 'feed' }
  override get keySchema(): ZodObject<ZodRawShape> { return z.object({ venue: z.string() }) }
  protected override startSubscribe(): void {}
  protected override stopSubscribe(): void {}
}

@OwAccount({ kind: 'test/fake' as NamespacedKind, displayName: 'Fake Account' })
class FakeAccount {
  constructor(readonly accountName: string, readonly session: unknown) {}
}

@OwExecutor({ name: 'Noop Executor' })
class NoopExecutor extends BaseExecutor<ExecutionInstruction> {
  constructor() { super() }   // BaseExecutor's ctor is protected; manifest classes need a public one
  get executorName() { return 'noop' }
  get supportedActions() { return ['noop'] }
  async execute(i: ExecutionInstruction): Promise<ExecutionResult<ExecutionInstruction>> {
    return { instruction: i, status: 'success', executedAt: new Date() }
  }
}

describe('definePlugin lowering', () => {
  it('lowers decorated classes into runtime registrations; decorators attach, never register', () => {
    const factory = definePlugin({
      name: 'demo', version: '1.0.0',
      monitors: [FeedMonitor],
      accounts: [FakeAccount],
      executors: [NoopExecutor],
      adapters: [{ kind: 'test/fake', type: 'demo', create: () => ({}) }],
    })
    const plugin = factory({ credentials: {} as never, config: {} })

    expect(plugin.monitorImplementations).toHaveLength(1)
    // definePlugin output is fully lowered — plain registrations, never classes
    const impl = plugin.monitorImplementations![0]! as import('../../types/monitorInstance.js').MonitorImplementation
    expect(impl).toMatchObject({ id: 'feed', contract: 'feed', displayName: 'Feed', credential: { type: 'svc', level: 'optional' } })
    const runner = impl.create({ adapters: {} as never })
    expect(runner).toBeInstanceOf(FeedMonitor)

    expect(plugin.accounts).toHaveLength(1)
    const acct = plugin.accounts![0]! as import('../../types/account.js').AccountImplementation
    expect(acct.id).toBe('fake-account')             // kebab-cased class name
    expect(acct.kind).toBe('test/fake')
    const reader = acct.createReader({ s: 1 }, 'My Acct') as FakeAccount
    expect(reader.accountName).toBe('My Acct')
    // @OwAccount also assigns the static kind, so the class works as a slot declaration
    expect((FakeAccount as { kind?: string }).kind).toBe('test/fake')

    expect(plugin.executors).toHaveLength(1)
    expect(plugin.executors![0]!.definition).toMatchObject({ id: 'noop', name: 'Noop Executor', supportedActions: ['noop'] })
  })

  it('rejects undecorated classes with a pointed error', () => {
    class Bare {}
    const factory = definePlugin({ name: 'demo', version: '1.0.0', accounts: [Bare as never] })
    expect(() => factory({ credentials: {} as never, config: {} })).toThrow(/@OwAccount metadata/)
  })
})
