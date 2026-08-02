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
import type { StrategyDeclarations } from '../../strategy/BaseStrategy.js'
import type { StrategyContext } from '../../types/strategy.js'
import type { StrategyParams } from '../../types/instance.js'
import type { Trigger } from '../../types/trigger.js'
import type { ExecutionInstruction, ExecutionResult } from '../../types/executor.js'
import type { ExecutorCredentialSlot } from '../../types/materialization.js'
import type { CredentialStore } from '../../types/credential.js'

/**
 * Credential materialization end-to-end, domain-free: a fake kind 'test/fake'
 * with fake sessions/readers proves the core machinery — ONE strategy, two
 * venues (credential types), instances routed by the bound credential; the
 * strategy holds only Readers; the executor receives the venue's session.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-mat-test-'))

interface FakeSession {
  venue: string
  orders: string[]
  close(): Promise<void>
}

class FakeReader {
  static readonly kind = 'test/fake' as const
  constructor(readonly name: string, private readonly session: FakeSession) {}
  venue(): string { return this.session.venue }
}

const credentials: Record<string, { type: string }> = {
  'A Main': { type: 'venue-a' },
  'B Main': { type: 'venue-b' },
  'Bot': { type: 'token-service' },
}

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async (name: string) => {
    const c = credentials[name]
    if (!c) throw new Error(`no credential ${name}`)
    return { type: c.type, data: { secret: `${name}-secret` } }
  },
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

/** Executor consuming a 'test/fake' session plus a raw token slot. */
class FakeVenueExecutor extends BaseExecutor<ExecutionInstruction> {
  constructor() { super() }
  get executorName() { return 'trade' }
  get supportedActions() { return ['noop'] }
  override get credentials(): readonly ExecutorCredentialSlot[] {
    return [
      { label: 'trading', kind: 'test/fake' },
      { label: 'bot', type: 'token-service', raw: true },
    ]
  }
  async execute(i: ExecutionInstruction): Promise<ExecutionResult<ExecutionInstruction>> {
    const session = this.session<FakeSession>('trading')
    const token = this.raw('bot')
    session.orders.push(`${i.params['symbol']}|token=${String(token['secret'])}`)
    return { instruction: i, status: 'success', executedAt: new Date() }
  }
}

const decls = {
  monitors: [{ name: 'signal', label: 'sig' }],
  executors: [{ name: 'trade', label: 'exec' }],
  accounts: [{ account: FakeReader, label: 'main' }],
} as const satisfies StrategyDeclarations

class AnyVenueStrategy extends BaseStrategy<typeof decls> {
  readonly strategyId = 'any-venue'
  override readonly monitors = decls.monitors
  override readonly executors = decls.executors
  override readonly accounts = decls.accounts
  override readonly baseParamsSchema = z.object({ symbol: z.string() })

  override triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    void this.baseParamsSchema.parse(params.base)
    return [{ enabled: true, conditions: [{ type: 'monitor', sources: [{ monitorName: this.monitor('sig'), key: 'tick' }] }] }]
  }

  async evaluate(_ctx: StrategyContext): Promise<ExecutionInstruction[]> {
    const { symbol } = this.baseParamsSchema.parse(this.params.base)
    const reader = this.account('main')   // FakeReader — typed via the class reference
    return [this.instruction('exec', 'noop', { symbol: `${symbol}@${reader.venue()}` }, ['main'])]
  }
}

const sessionsByVenue: Record<string, FakeSession[]> = { 'venue-a': [], 'venue-b': [] }

function makeSessionFactory(venue: string) {
  return () => {
    const session: FakeSession = { venue, orders: [], close: async () => undefined }
    sessionsByVenue[venue]!.push(session)
    return session
  }
}

function setupRuntime(): OpenWhaleRuntime {
  const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, queue: new MemoryExecutionQueue() })
  // Kind vocabulary is derived — the kind-generic account implementation IS
  // the canonical read view (also the legacy bare-credential fallback).
  runtime.registerAccountImplementation('test', {
    id: 'fake-account',
    kind: 'test/fake',
    createReader: (session, name) => new FakeReader(name, session as FakeSession),
  })
  runtime.registerCredentialType({ type: 'venue-a', factories: { 'test/fake': makeSessionFactory('venue-a') } as never })
  runtime.registerCredentialType({ type: 'venue-b', factories: { 'test/fake': makeSessionFactory('venue-b') } as never })
  runtime.registerCredentialType({ type: 'token-service', raw: true })
  return runtime
}

describe('credential materialization: one strategy, two venues', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('routes each instance to the venue of its bound credential; executor gets session + raw', async () => {
    const monitor = new SignalMonitor()
    const runtime = setupRuntime()
    const now = new Date().toISOString()
    runtime.registerMonitor({ id: 'signal', name: 'Signal', source: 'builtin', createdAt: now, updatedAt: now }, monitor)
    runtime.registerExecutor(
      { id: 'trade', name: 'Trade', source: 'builtin', supportedActions: ['noop'], createdAt: now, updatedAt: now },
      new FakeVenueExecutor(),
    )
    runtime.registerStrategy(
      { id: 'any-venue', name: 'Any Venue', source: 'builtin', createdAt: now, updatedAt: now },
      () => new AnyVenueStrategy(),
    )

    // accountRequirements derived from the class-reference declarations
    const def = runtime.listStrategies().find(s => s.id === 'any-venue')!
    expect(def.accountRequirements).toEqual([{ label: 'main', kind: 'test/fake' }])

    await runtime.start()

    // ONE strategyId — venue chosen per instance purely by the bound credential.
    // Executor slots use the named map; the raw bot slot binds explicitly.
    await runtime.activate({
      id: 'on-a', name: 'A', strategyId: 'any-venue',
      credentials: { main: 'A Main', 'exec:bot': 'Bot' },
      params: { base: { symbol: 'BTC' }, tunable: {} }, enabled: true, createdAt: now, updatedAt: now,
    })
    await runtime.activate({
      id: 'on-b', name: 'B', strategyId: 'any-venue',
      credentials: { main: 'B Main', 'exec:bot': 'Bot' },
      params: { base: { symbol: 'ETH' }, tunable: {} }, enabled: true, createdAt: now, updatedAt: now,
    })

    await monitor.fire('tick')
    await new Promise(r => setTimeout(r, 100))   // let the executor consume loop drain

    const aOrders = sessionsByVenue['venue-a']!.flatMap(s => s.orders)
    const bOrders = sessionsByVenue['venue-b']!.flatMap(s => s.orders)
    expect(aOrders).toEqual(['BTC@venue-a|token=Bot-secret'])
    expect(bOrders).toEqual(['ETH@venue-b|token=Bot-secret'])

    await runtime.stop()
  })

  it('rejects a credential whose type has no factory for the declared kind', async () => {
    const runtime = setupRuntime()
    const now = new Date().toISOString()
    runtime.registerStrategy(
      { id: 'any-venue', name: 'AV', source: 'builtin', createdAt: now, updatedAt: now },
      () => new AnyVenueStrategy(),
    )
    await expect(runtime.activate({
      id: 'bad', name: 'Bad', strategyId: 'any-venue',
      credentials: { main: 'Bot' },   // token-service has no 'test/fake' factory
      params: { base: { symbol: 'X' }, tunable: {} }, enabled: true, createdAt: now, updatedAt: now,
    })).rejects.toThrow(/has no adapter for kind "test\/fake"/)
  })

  it('rejects non-namespaced kinds at registration (fail-closed vocabulary)', () => {
    const runtime = setupRuntime()
    expect(() => runtime.registerAccountImplementation('test', { id: 'bad', kind: 'perp' as never, createReader: (s: unknown) => s }))
      .toThrow(/must be namespaced/)
  })

  it('rejects an account slot whose Reader class has no kind', () => {
    class KindlessReader {
      constructor(readonly name: string) {}
    }
    class BadStrategy extends BaseStrategy {
      readonly strategyId = 'kindless'
      override readonly accounts = [{ account: KindlessReader, label: 'main' }]
      readonly baseParamsSchema = z.object({})
      readonly tunableParamsSchema = z.object({})
      async evaluate(): Promise<ExecutionInstruction[]> { return [] }
    }
    const runtime = setupRuntime()
    const now = new Date().toISOString()
    expect(() => runtime.registerStrategy(
      { id: 'kindless', name: 'Kindless', source: 'builtin', createdAt: now, updatedAt: now },
      () => new BadStrategy(),
    )).toThrow(/Reader class has no kind/)
  })

  it('rejects a strategy that sets strategyId neither by field nor by @Strategy', () => {
    class NoId extends BaseStrategy {
      readonly baseParamsSchema = z.object({})
      readonly tunableParamsSchema = z.object({})
      async evaluate(): Promise<ExecutionInstruction[]> { return [] }
    }
    const runtime = setupRuntime()
    const now = new Date().toISOString()
    expect(() => runtime.registerStrategy(
      { id: 'no-id', name: 'No Id', source: 'builtin', createdAt: now, updatedAt: now },
      () => new NoId(),
    )).toThrow(/has no strategyId/)
  })
})
