import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { SQLiteAdapter } from '@openwhaleorg/core'
import { PositionGroups, liveOf, asDate, startMsOf } from '../positionGroups.js'

let db: SQLiteAdapter

const accounts = [
  { name: 'BN Sub', credential: 'bn-sub', kind: 'exchange/perp' },
  { name: 'Perp B', credential: 'perp-b', kind: 'exchange/perp' },
  { name: 'BN Spot', credential: 'bn-sub', kind: 'exchange/spot' },
]

function runtime(instances: Array<{ id: string; name: string; strategyId: string; active?: boolean; credentials?: Record<string, string>; params?: unknown }>) {
  const positions: Record<string, Array<{ id: string; side: string; value: number; pnl: number }>> = {
    'BN Sub': [
      { id: 'CL/USDT:USDT', side: 'short', value: 80_000, pnl: 864 },
      { id: 'CL/USDT:USDT', side: 'long', value: 22_000, pnl: 1_424 },
      { id: 'BZ/USDT:USDT', side: 'short', value: 84_000, pnl: -5_305 },
    ],
    'Perp B': [{ id: 'BAR/USDC:USDC', side: 'long', value: 79_000, pnl: -700 }],
  }
  return {
    listInstanceViews: async () => instances,
    listAccounts: async () => accounts,
    accountDetail: async (name: string) => {
      if (name === 'Broken') throw new Error('venue down')
      return { sections: { positions: positions[name] ?? [] }, errors: {} }
    },
    // A pair strategy's legs: both contracts on the bound venue credential, either side.
    instancePositionLegs: (inst: { strategyId: string; credentials?: Record<string, string>; params?: { base?: Record<string, unknown> } }) =>
      inst.strategyId === 'pair-arb/etf-dual-remote'
        ? [{ credential: inst.credentials!['engine:venue']!, symbol: String(inst.params!.base!['symbolA']) }, { credential: inst.credentials!['engine:venue']!, symbol: String(inst.params!.base!['symbolB']) }]
        : [],
  }
}

beforeEach(async () => { db = new SQLiteAdapter({ filePath: ':memory:' }); await db.initialize() })
afterEach(async () => { await (db as unknown as { close?: () => Promise<void> }).close?.() })

describe('PositionGroups', () => {
  it('a manual combination spans accounts and adds up what its members hold', async () => {
    const pg = new PositionGroups(db, runtime([]) as never)
    const g = await pg.create('Cross-venue spread', [
      { account: 'BN Sub', symbol: 'CL/USDT:USDT', side: 'short' },
      { account: 'Perp B', symbol: 'BAR/USDC:USDC', side: '*' },
    ])
    expect(g.members).toHaveLength(2)
    const { groups } = await pg.live()
    const live = groups.find(x => x.id === g.id)!
    // The long CL on BN Sub is not a member: the short is.
    expect(live.totals.pnl).toBeCloseTo(864 - 700, 9)
    expect(live.totals.gross).toBe(159_000)
    expect(live.totals.net).toBe(-1_000)
  })

  it('an instance with legs gets a combination that follows it, and loses it when the instance goes', async () => {
    const inst = { id: 'inst_a', name: 'BZ/CL', strategyId: 'pair-arb/etf-dual-remote', credentials: { 'engine:venue': 'bn-sub' }, params: { base: { symbolA: 'BZ/USDT:USDT', symbolB: 'CL/USDT:USDT' }, tunable: {} } }
    const rt = runtime([inst])
    const pg = new PositionGroups(db, rt as never)
    let [g] = (await pg.list()).filter(x => x.source === 'instance')
    expect(g!.name).toBe('BZ/CL')
    // Only the perp account on that credential, and either side.
    expect(g!.members).toEqual([
      { account: 'BN Sub', symbol: 'BZ/USDT:USDT', side: '*' },
      { account: 'BN Sub', symbol: 'CL/USDT:USDT', side: '*' },
    ])
    const live = (await pg.live()).groups.find(x => x.id === g!.id)!
    expect(live.totals.open).toBe(3)
    expect(live.totals.pnl).toBeCloseTo(-5_305 + 864 + 1_424, 9)

    // Hidden survives a sync; members cannot be edited by hand.
    await pg.update(g!.id, { hidden: true })
    ;[g] = (await pg.list()).filter(x => x.source === 'instance')
    expect(g!.hidden).toBe(true)
    await expect(pg.addMembers(g!.id, [{ account: 'Perp B', symbol: 'X', side: '*' }])).rejects.toThrow()
    await expect(pg.remove(g!.id)).rejects.toThrow()

    rt.listInstanceViews = async () => []
    expect((await pg.list()).filter(x => x.source === 'instance')).toHaveLength(0)
  })

  it('an unreadable account marks its members and the rest still add up', () => {
    const live = liveOf(
      { id: 'g', name: 'x', source: 'manual', hidden: false, sortOrder: 0, members: [{ account: 'Broken', symbol: 'A', side: '*' }, { account: 'BN Sub', symbol: 'B', side: 'long' }] },
      new Map([['Broken', { rows: [], error: 'venue down' }], ['BN Sub', { rows: [{ id: 'B', side: 'long', value: 10, pnl: 2 }] }]]),
    )
    expect(live.members[0]!.error).toBe('venue down')
    expect(live.totals.pnl).toBe(2)
  })

  it('a start date is kept, cleared, and read as UTC midnight', async () => {
    const pg = new PositionGroups(db, runtime([]) as never)
    const g = await pg.create('Cross-venue spread', [], '2026-09-12')
    expect((await pg.list()).find(x => x.id === g.id)!.startAt).toBe('2026-09-12')
    expect(startMsOf(g.startAt)).toBe(Date.parse('2026-09-12T00:00:00Z'))

    await pg.update(g.id, { startAt: null })
    expect((await pg.list()).find(x => x.id === g.id)!.startAt).toBeUndefined()
    expect(startMsOf(undefined)).toBeUndefined()

    // A date, however it arrives: an ISO timestamp is cut to its day, junk is nothing.
    expect(asDate('2026-09-12T08:30:00.000Z')).toBe('2026-09-12')
    expect(asDate('  2026-09-12 ')).toBe('2026-09-12')
    expect(asDate('last tuesday')).toBeNull()
    expect(asDate(1_757_000_000_000)).toBeNull()
  })

  it('a database created before the start date gets the column added', async () => {
    // The shape production is on: the table already exists without start_at.
    await db.run('DROP TABLE IF EXISTS position_groups')
    await db.run(`CREATE TABLE position_groups (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, instance_id TEXT,
      hidden INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    await db.run("INSERT INTO position_groups VALUES ('old', 'legacy', 'manual', NULL, 0, 0, 'x', 'x')")
    const pg = new PositionGroups(db, runtime([]) as never)
    const found = (await pg.list()).find(x => x.id === 'old')!
    expect(found.name).toBe('legacy')
    expect(found.startAt).toBeUndefined()
    await pg.update('old', { startAt: '2026-09-01' })
    expect((await pg.list()).find(x => x.id === 'old')!.startAt).toBe('2026-09-01')
  })

  it("an instance's combination takes a start date and keeps it across a sync", async () => {
    const inst = { id: 'inst_a', name: 'BZ/CL', strategyId: 'pair-arb/etf-dual-remote', credentials: { 'engine:venue': 'bn-sub' }, params: { base: { symbolA: 'BZ/USDT:USDT', symbolB: 'CL/USDT:USDT' }, tunable: {} } }
    const pg = new PositionGroups(db, runtime([inst]) as never)
    const [g] = (await pg.list()).filter(x => x.source === 'instance')
    // Members are the instance's, but when its history starts is the operator's.
    await pg.update(g!.id, { startAt: '2026-09-18' })
    const after = (await pg.list()).find(x => x.id === g!.id)!
    expect(after.startAt).toBe('2026-09-18')
    expect(after.members).toHaveLength(2)
  })

  it('a stopped instance hides its combination by default; once the operator says otherwise, that wins', async () => {
    const inst = { id: 'inst_a', name: 'BZ/CL', strategyId: 'pair-arb/etf-dual-remote', active: false, credentials: { 'engine:venue': 'bn-sub' }, params: { base: { symbolA: 'BZ/USDT:USDT', symbolB: 'CL/USDT:USDT' }, tunable: {} } }
    const rt = runtime([inst])
    const pg = new PositionGroups(db, rt as never)
    expect((await pg.list()).find(g => g.source === 'instance')!.hidden).toBe(true)

    // The instance is running and nobody has said otherwise: follow the state.
    inst.active = true
    expect((await pg.list()).find(g => g.source === 'instance')!.hidden).toBe(false)

    // The operator hid it: no state change touches it again.
    const g = (await pg.list()).find(x => x.source === 'instance')!
    await pg.update(g.id, { hidden: true })
    inst.active = false
    expect((await pg.list()).find(x => x.id === g.id)!.hidden).toBe(true)
    await pg.update(g.id, { hidden: false })
    inst.active = false
    expect((await pg.list()).find(x => x.id === g.id)!.hidden).toBe(false)
  })

  it('a manual combination can be renamed, edited and deleted', async () => {
    const pg = new PositionGroups(db, runtime([]) as never)
    const g = await pg.create('a')
    await pg.update(g.id, { name: 'b' })
    await pg.addMembers(g.id, [{ account: 'BN Sub', symbol: 'BZ/USDT:USDT', side: 'short' }, { account: 'BN Sub', symbol: 'BZ/USDT:USDT', side: 'short' }])
    let found = (await pg.list()).find(x => x.id === g.id)!
    expect(found.name).toBe('b')
    expect(found.members).toHaveLength(1)
    await pg.removeMember(g.id, { account: 'BN Sub', symbol: 'BZ/USDT:USDT', side: 'short' })
    found = (await pg.list()).find(x => x.id === g.id)!
    expect(found.members).toHaveLength(0)
    await pg.remove(g.id)
    expect((await pg.list()).find(x => x.id === g.id)).toBeUndefined()
  })
})
