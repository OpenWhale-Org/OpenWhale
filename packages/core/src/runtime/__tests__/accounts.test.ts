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
 * Account entities end-to-end: strategy slots bind ACCOUNT names; the entity
 * supplies implementation + credential; the implementation builds the read
 * view; the executor receives the underlying session. Legacy credential-name
 * bindings still work (covered by materialization.test.ts).
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-acct-test-'))

interface FakeSession { venue: string; orders: string[]; close(): Promise<void> }

class FakeReader {
  static readonly kind = 'test/fake' as const
  constructor(readonly name: string, private readonly session: FakeSession) {}
  venue(): string { return this.session.venue }
}

/** A specialized reader for venue-b — proves impl selection, not kind fallback. */
class SpecialReader extends FakeReader {
  special(): boolean { return true }
}

const credentials: Record<string, { type: string }> = {
  'A Key': { type: 'venue-a' },
  'B Key': { type: 'venue-b' },
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

class FakeVenueExecutor extends BaseExecutor<ExecutionInstruction> {
  constructor() { super() }
  get executorName() { return 'trade' }
  get supportedActions() { return ['noop'] }
  override get credentials(): readonly ExecutorCredentialSlot[] {
    return [{ label: 'trading', kind: 'test/fake' }]
  }
  async execute(i: ExecutionInstruction): Promise<ExecutionResult<ExecutionInstruction>> {
    this.session<FakeSession>('trading').orders.push(String(i.params['symbol']))
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
    const reader = this.account('main')
    const tag = reader instanceof SpecialReader ? 'special' : 'generic'
    return [this.instruction('exec', 'noop', { symbol: `${symbol}@${reader.venue()}#${tag}` }, ['main'])]
  }
}

const sessionsByVenue: Record<string, FakeSession[]> = { 'venue-a': [], 'venue-b': [] }

function makeCreate(venue: string) {
  return () => {
    const session: FakeSession = { venue, orders: [], close: async () => undefined }
    sessionsByVenue[venue]!.push(session)
    return session
  }
}

function setupRuntime(): OpenWhaleRuntime {
  const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, queue: new MemoryExecutionQueue() })
  runtime.registerCredentialType({ type: 'venue-a' })
  runtime.registerCredentialType({ type: 'venue-b' })
  // Adapter cells (the new matrix) instead of legacy factories
  runtime.loadPlugin(() => ({
    name: 'fakes', version: '0.0.0', monitors: [], executors: [], strategies: [],
    adapters: [
      { kind: 'test/fake', type: 'venue-a', create: makeCreate('venue-a') },
      { kind: 'test/fake', type: 'venue-b', create: makeCreate('venue-b') },
    ],
    accounts: [
      { id: 'fake-account', kind: 'test/fake', createReader: (s, n) => new FakeReader(n, s as FakeSession) },
      { id: 'special-account', kind: 'test/fake', type: 'venue-b', createReader: (s, n) => new SpecialReader(n, s as FakeSession) },
    ],
  }), {})
  return runtime
}

describe('account entities', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('binds slots by account name; specialization picked per entity; executor gets the session', async () => {
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

    // Two accounts over two venues; venue-b uses the SPECIALIZED implementation
    await runtime.saveAccount({ name: 'Alpha', implementation: 'fakes/fake-account', credential: 'A Key' })
    await runtime.saveAccount({ name: 'Beta', implementation: 'fakes/special-account', credential: 'B Key' })

    const views = await runtime.listAccounts()
    expect(views.map(v => [v.name, v.status, v.type])).toEqual([
      ['Alpha', 'ready', 'venue-a'],
      ['Beta', 'ready', 'venue-b'],
    ])

    await runtime.start()

    await runtime.activate({
      id: 'on-a', name: 'A', strategyId: 'any-venue',
      credentials: { main: 'Alpha' },
      params: { base: { symbol: 'BTC' }, tunable: {} }, enabled: true, createdAt: now, updatedAt: now,
    })
    await runtime.activate({
      id: 'on-b', name: 'B', strategyId: 'any-venue',
      credentials: { main: 'Beta' },
      params: { base: { symbol: 'ETH' }, tunable: {} }, enabled: true, createdAt: now, updatedAt: now,
    })

    await monitor.fire('tick')
    await new Promise(r => setTimeout(r, 100))

    expect(sessionsByVenue['venue-a']!.flatMap(s => s.orders)).toEqual(['BTC@venue-a#generic'])
    expect(sessionsByVenue['venue-b']!.flatMap(s => s.orders)).toEqual(['ETH@venue-b#special'])

    await runtime.stop()
  })

  it('rejects activation on an account with no credential bound', async () => {
    const runtime = setupRuntime()
    const now = new Date().toISOString()
    runtime.registerStrategy(
      { id: 'any-venue', name: 'AV', source: 'builtin', createdAt: now, updatedAt: now },
      () => new AnyVenueStrategy(),
    )
    await runtime.saveAccount({ name: 'Hollow', implementation: 'fakes/fake-account' })
    expect((await runtime.listAccounts()).find(v => v.name === 'Hollow')?.status).toBe('inactive')

    await expect(runtime.activate({
      id: 'bad', name: 'Bad', strategyId: 'any-venue',
      credentials: { main: 'Hollow' },
      params: { base: { symbol: 'X' }, tunable: {} }, enabled: true, createdAt: now, updatedAt: now,
    })).rejects.toThrow(/has no credential bound/)
  })

  it('rejects saving an account whose credential type mismatches the specialization', async () => {
    const runtime = setupRuntime()
    await expect(runtime.saveAccount({ name: 'Wrong', implementation: 'fakes/special-account', credential: 'A Key' }))
      .rejects.toThrow(/requires a "venue-b" credential/)
  })

  it('samples equity through the read view snapshot() convention', async () => {
    const runtime = setupRuntime()
    // A specialized impl whose read view implements snapshot()
    runtime.registerAccountImplementation('test', {
      id: 'snap-account', kind: 'test/fake', type: 'venue-a',
      createReader: (session) => ({
        venue: () => (session as FakeSession).venue,
        snapshot: async () => ({ equity: 1234.5, available: 1000, unrealizedPnl: 34.5 }),
      }),
    })
    await runtime.saveAccount({ name: 'Snappy', implementation: 'test/snap-account', credential: 'A Key' })
    // FakeReader (no snapshot method) accounts are skipped silently
    await runtime.saveAccount({ name: 'Plain', implementation: 'fakes/fake-account', credential: 'B Key' })

    await runtime.snapshotAccounts()

    const latest = await runtime.latestAccountSnapshots()
    expect(latest['Snappy']).toMatchObject({ equity: 1234.5, available: 1000, unrealizedPnl: 34.5 })
    expect(latest['Plain']).toBeUndefined()

    const series = await runtime.accountEquitySeries('Snappy', 0)
    expect(series).toHaveLength(1)
    expect(series[0]!.equity).toBe(1234.5)
  })

  it('refuses to delete an account bound by an active instance', async () => {
    const runtime = setupRuntime()
    const now = new Date().toISOString()
    runtime.registerMonitor({ id: 'signal', name: 'Signal', source: 'builtin', createdAt: now, updatedAt: now }, new SignalMonitor())
    runtime.registerExecutor(
      { id: 'trade', name: 'Trade', source: 'builtin', supportedActions: ['noop'], createdAt: now, updatedAt: now },
      new FakeVenueExecutor(),
    )
    runtime.registerStrategy(
      { id: 'any-venue', name: 'AV', source: 'builtin', createdAt: now, updatedAt: now },
      () => new AnyVenueStrategy(),
    )
    await runtime.saveAccount({ name: 'Held', implementation: 'fakes/fake-account', credential: 'A Key' })
    await runtime.activate({
      id: 'holder', name: 'H', strategyId: 'any-venue',
      credentials: { main: 'Held' },
      params: { base: { symbol: 'X' }, tunable: {} }, enabled: true, createdAt: now, updatedAt: now,
    })
    await expect(runtime.deleteAccount('Held')).rejects.toThrow(/active instance/)
    await runtime.deactivate('holder')
    await expect(runtime.deleteAccount('Held')).resolves.toBeUndefined()
  })
})
