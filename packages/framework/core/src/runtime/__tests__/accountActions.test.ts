import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { z } from 'zod'
import { OpenWhaleRuntime } from '../OpenWhaleRuntime.js'
import { MemoryExecutionQueue } from '../../executor/MemoryExecutionQueue.js'
import type { CredentialStore } from '../../types/credential.js'
import type { AccountActionRecord } from '../../types/account.js'

/**
 * Operator writes on an account: which actions an implementation offers, that
 * params are validated before the venue is touched, and that every attempt —
 * won or lost — is written down. The last one is the whole safety story: this
 * is the one path where an order reaches a venue with no instruction, no queue
 * and no instance behind it.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-acct-action-test-'))

interface FakeSession {
  venue: string
  sent: Array<Record<string, unknown>>
  openOrders: Array<{ id: string; symbol: string }>
  failNext?: string
}

const credentialStore: CredentialStore = {
  set: async () => ({ id: 'x', name: 'x', type: 'x', createdAt: '', updatedAt: '' }),
  getByName: async (name: string) => ({ type: 'venue-a', data: { secret: `${name}-secret` } }),
  delete: async () => undefined,
  list: async () => [],
}

class Reader {
  constructor(readonly name: string, private readonly session: FakeSession) {}
  venue(): string { return this.session.venue }
}

class Writer {
  static readonly actions = [
    {
      id: 'placeOrder',
      displayName: 'Place order',
      group: 'Order',
      danger: true,
      paramsSchema: z.object({
        symbol: z.string().min(1),
        amount: z.number().positive(),
      }),
      paramOptions: async (ctx: { session: unknown; account: string }) => ({
        symbol: (ctx.session as FakeSession).openOrders.map(o => ({ label: o.symbol, value: o.symbol })),
      }),
    },
    {
      id: 'cancelAll',
      displayName: 'Cancel all',
    },
    {
      id: 'flaky',
      displayName: 'Flaky',
      paramsSchema: z.object({ why: z.string() }),
      paramOptions: async () => { throw new Error('venue is down') },
    },
  ]

  constructor(readonly name: string, private readonly session: FakeSession) {}

  async placeOrder(p: { symbol: string; amount: number }) {
    if (this.session.failNext === 'placeOrder') throw new Error('insufficient margin')
    this.session.sent.push(p)
    return { orderId: `ord-${this.session.sent.length}` }
  }

  async cancelAll() {
    this.session.openOrders = []
    return { cancelled: true }
  }

  async flaky(p: { why: string }) { return p }
}

let session: FakeSession

function setupRuntime(): OpenWhaleRuntime {
  session = { venue: 'venue-a', sent: [], openOrders: [{ id: 'o1', symbol: 'BTC/USDT:USDT' }] }
  const runtime = new OpenWhaleRuntime({ dataDir: tmpDir, credentialStore, queue: new MemoryExecutionQueue() })
  runtime.registerCredentialType({ type: 'venue-a' })
  runtime.loadPlugin(() => ({
    name: 'fakes', version: '0.0.0',
    adapters: [{ kind: 'test/fake', type: 'venue-a', create: () => session }],
    accounts: [
      {
        id: 'writable', kind: 'test/fake',
        createReader: (s, n) => new Reader(n, s as FakeSession),
        actions: Writer.actions,
        createWriter: (s, n) => new Writer(n, s as FakeSession),
      },
      { id: 'readonly', kind: 'test/fake', createReader: (s, n) => new Reader(n, s as FakeSession) },
    ],
  }), {})
  return runtime
}

/** The audit trail, as an operator would find it in the executions explorer. */
function recorded(): AccountActionRecord[] {
  const dir = path.join(tmpDir, 'executions', 'account-actions')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).flatMap(f =>
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as AccountActionRecord))
}

describe('account write actions', () => {
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))

  it('offers actions only where the implementation declares them', async () => {
    const runtime = setupRuntime()
    await runtime.saveAccount({ name: 'Writable', implementation: 'fakes/writable', credential: 'A Key' })
    await runtime.saveAccount({ name: 'Readonly', implementation: 'fakes/readonly', credential: 'A Key' })

    const views = await runtime.listAccounts()
    expect(views.find(v => v.name === 'Writable')?.writable).toBe(true)
    // Absent, not false — a read-only account is the default, and the flag only
    // exists to turn the Trade tab ON.
    expect(views.find(v => v.name === 'Readonly')?.writable).toBeUndefined()
    expect(await runtime.listAccountActions('Readonly')).toEqual([])
  })

  it('derives each action a form, and resolves its dropdowns against the live account', async () => {
    const runtime = setupRuntime()
    await runtime.saveAccount({ name: 'Writable', implementation: 'fakes/writable', credential: 'A Key' })

    const actions = await runtime.listAccountActions('Writable')
    expect(actions.map(a => a.id)).toEqual(['placeOrder', 'cancelAll', 'flaky'])

    const place = actions.find(a => a.id === 'placeOrder')!
    expect(place).toMatchObject({ displayName: 'Place order', group: 'Order', danger: true })
    const symbol = place.paramsFields!.find(f => f.name === 'symbol')!
    expect(symbol.type).toBe('options')
    expect(symbol.options).toEqual([{ label: 'BTC/USDT:USDT', value: 'BTC/USDT:USDT' }])

    // No schema, no form — a one-click action is a legitimate shape.
    expect(actions.find(a => a.id === 'cancelAll')!.paramsFields).toBeUndefined()
  })

  it('a broken option resolver costs the dropdown, not the action', async () => {
    const runtime = setupRuntime()
    await runtime.saveAccount({ name: 'Writable', implementation: 'fakes/writable', credential: 'A Key' })

    const flaky = (await runtime.listAccountActions('Writable')).find(a => a.id === 'flaky')!
    // The field survives as a plain input: a venue that cannot list must not
    // take the whole action away from an operator who knows what to type.
    expect(flaky.paramsFields!.find(f => f.name === 'why')!.type).not.toBe('options')
  })

  it('runs the write and records it, actor included', async () => {
    const runtime = setupRuntime()
    await runtime.saveAccount({ name: 'Writable', implementation: 'fakes/writable', credential: 'A Key' })

    const before = recorded().length
    const out = await runtime.runAccountAction('Writable', 'placeOrder', { symbol: 'BTC/USDT:USDT', amount: 0.5 }, 'ja')
    expect(out).toEqual({ orderId: 'ord-1' })
    expect(session.sent).toEqual([{ symbol: 'BTC/USDT:USDT', amount: 0.5 }])

    const rec = recorded().slice(before)
    expect(rec).toHaveLength(1)
    expect(rec[0]).toMatchObject({
      status: 'success',
      data: { orderId: 'ord-1' },
      instruction: {
        action: 'placeOrder',
        executorId: 'account-actions',
        params: { symbol: 'BTC/USDT:USDT', amount: 0.5 },
        accountNames: ['Writable'],
        implementation: 'fakes/writable',
        actor: 'ja',
      },
    })
    // No instanceId and no runId: nothing decided this but a person, and that
    // absence is how the Executions page tells a manual write from a strategy's.
    expect(rec[0]!.instruction).not.toHaveProperty('instanceId')
    expect(rec[0]!.instruction).not.toHaveProperty('runId')
  })

  it('records a FAILED write too — the one an operator goes looking for', async () => {
    const runtime = setupRuntime()
    await runtime.saveAccount({ name: 'Writable', implementation: 'fakes/writable', credential: 'A Key' })
    session.failNext = 'placeOrder'

    const before = recorded().length
    await expect(runtime.runAccountAction('Writable', 'placeOrder', { symbol: 'ETH/USDT:USDT', amount: 1 }, 'ja'))
      .rejects.toThrow(/insufficient margin/)

    const rec = recorded().slice(before)
    expect(rec).toHaveLength(1)
    expect(rec[0]).toMatchObject({
      status: 'failed', error: 'insufficient margin',
      instruction: { action: 'placeOrder', accountNames: ['Writable'], actor: 'ja' },
    })
  })

  it('validates params BEFORE the venue is touched', async () => {
    const runtime = setupRuntime()
    await runtime.saveAccount({ name: 'Writable', implementation: 'fakes/writable', credential: 'A Key' })

    const before = recorded().length
    await expect(runtime.runAccountAction('Writable', 'placeOrder', { symbol: 'BTC/USDT:USDT', amount: -5 }))
      .rejects.toThrow()
    // Nothing reached the venue, so nothing is recorded: an invalid form is a
    // typo, not an event.
    expect(session.sent).toEqual([])
    expect(recorded().slice(before)).toEqual([])
  })

  it('refuses an unknown action, and an account that offers none', async () => {
    const runtime = setupRuntime()
    await runtime.saveAccount({ name: 'Writable', implementation: 'fakes/writable', credential: 'A Key' })
    await runtime.saveAccount({ name: 'Readonly', implementation: 'fakes/readonly', credential: 'A Key' })
    await runtime.saveAccount({ name: 'Unbound', implementation: 'fakes/writable' })

    await expect(runtime.runAccountAction('Writable', 'nope', {})).rejects.toThrow(/no action "nope"/)
    await expect(runtime.runAccountAction('Readonly', 'placeOrder', {})).rejects.toThrow(/no action "placeOrder"/)
    await expect(runtime.runAccountAction('Unbound', 'cancelAll', {})).rejects.toThrow(/no credential bound/)
    await expect(runtime.runAccountAction('Ghost', 'cancelAll', {})).rejects.toThrow(/Unknown account/)
  })
})
