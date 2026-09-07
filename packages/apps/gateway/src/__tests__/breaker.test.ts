import { describe, it, expect, beforeEach, vi } from 'vitest'
import { SQLiteAdapter } from '@openwhaleorg/core'
import type { OpenWhaleRuntime, BreakerRule, PnlWindow, LedgerHealth, StrategyInstance } from '@openwhaleorg/core'
import { BreakerService } from '../maintenance/breaker.js'

/**
 * What the breaker must never do is stop a healthy instance, so most of these
 * assert a refusal rather than an action.
 */

const MIN = 60_000
let db: SQLiteAdapter
let deactivated: string[]

const LIVE: LedgerHealth = { live: true, oldestMarkTs: Date.now(), pairs: 3, stalePairs: 0 }
const BLIND: LedgerHealth = { live: false, oldestMarkTs: null, pairs: 3, stalePairs: 2, reason: 'collector is behind' }

function window(over: Partial<PnlWindow> = {}): PnlWindow {
  return {
    instanceId: 'inst', since: Date.now() - 60 * MIN,
    realized: 0, fees: 0, funding: 0, net: 0,
    fills: 0, closingFills: 0, wins: 0, winRatePct: null,
    ...over,
  }
}

/** A runtime with one armed instance and a scripted ledger. */
function runtimeWith(rules: BreakerRule[], ledger: LedgerHealth, w: PnlWindow, enabled = true): OpenWhaleRuntime {
  const instance = {
    id: 'inst', name: 'Test Instance', strategyId: 's', enabled: true,
    options: { breakerEnabled: enabled, breaker: rules },
  } as unknown as StrategyInstance
  return {
    listInstances: () => [instance],
    deactivate: async (id: string) => { deactivated.push(id) },
    pnl: {
      ledgerHealth: async () => ledger,
      instanceWindow: async () => w,
    },
  } as unknown as OpenWhaleRuntime
}

const lossRule = (over: Partial<BreakerRule> = {}): BreakerRule => ({
  id: 'r1', metric: 'netPnl', windowMin: 60, below: -50, action: 'alert', ...over,
})

async function service(rt: OpenWhaleRuntime): Promise<BreakerService> {
  const svc = new BreakerService(db, rt)
  await svc.initialize()
  svc.stop()   // no timer in tests; passes are driven by hand
  return svc
}

beforeEach(async () => {
  db = new SQLiteAdapter({ filePath: ':memory:' })
  await db.initialize()
  deactivated = []
  vi.restoreAllMocks()
})

describe('the ledger gate', () => {
  it('does nothing at all while the ledger is not live, however bad the number', async () => {
    // The COTI failure mode: a stopped collector reads exactly like a stopped
    // strategy. Acting on it would stop instances whenever monitoring breaks.
    const svc = await service(runtimeWith([lossRule({ action: 'deactivate' })], BLIND, window({ net: -100000 })))
    expect(await svc.evaluate('inst')).toEqual([])
    expect(deactivated).toEqual([])
    expect(await svc.trips()).toEqual([])
  })

  it('says WHY it is abstaining rather than reporting healthy', async () => {
    const svc = await service(runtimeWith([lossRule()], BLIND, window()))
    const st = await svc.status('inst')
    expect(st.ledger.live).toBe(false)
    expect(st.ledger.reason).toBe('collector is behind')
    expect(st.windows).toBeUndefined()
  })
})

describe('net PnL rules', () => {
  it('trips when the window is below the threshold', async () => {
    const svc = await service(runtimeWith([lossRule()], LIVE, window({ net: -80, realized: -80, fills: 4 })))
    const trips = await svc.evaluate('inst')
    expect(trips).toHaveLength(1)
    expect(trips[0]).toMatchObject({ ruleId: 'r1', observed: -80, threshold: -50, action: 'alert' })
  })

  it('does not trip at the threshold — below means below', async () => {
    const svc = await service(runtimeWith([lossRule()], LIVE, window({ net: -50 })))
    expect(await svc.evaluate('inst')).toEqual([])
  })

  it('does not trip on a profit', async () => {
    const svc = await service(runtimeWith([lossRule()], LIVE, window({ net: 120 })))
    expect(await svc.evaluate('inst')).toEqual([])
  })
})

describe('win rate rules', () => {
  const wr = (over: Partial<BreakerRule> = {}): BreakerRule => ({
    id: 'w1', metric: 'winRate', windowMin: 240, below: 40, action: 'alert', ...over,
  })

  it('holds fire until there are enough closing fills', async () => {
    // 0% over two closes is noise; tripping on it would page on every pair of
    // unlucky trades.
    const svc = await service(runtimeWith([wr()], LIVE, window({ closingFills: 2, wins: 0, winRatePct: 0 })))
    expect(await svc.evaluate('inst')).toEqual([])
  })

  it('trips once the sample is big enough', async () => {
    const svc = await service(runtimeWith([wr()], LIVE, window({ closingFills: 20, wins: 4, winRatePct: 20 })))
    const trips = await svc.evaluate('inst')
    expect(trips).toHaveLength(1)
    expect(trips[0]!.observed).toBe(20)
  })

  it('minSamples is configurable per rule', async () => {
    const w = window({ closingFills: 4, wins: 0, winRatePct: 0 })
    expect(await (await service(runtimeWith([wr({ minSamples: 3 })], LIVE, w))).evaluate('inst')).toHaveLength(1)
    expect(await (await service(runtimeWith([wr({ minSamples: 5 })], LIVE, w))).evaluate('inst')).toEqual([])
  })

  it('never trips when nothing has closed — null is not zero', async () => {
    const svc = await service(runtimeWith([wr({ minSamples: 0 })], LIVE, window({ closingFills: 0, winRatePct: null })))
    expect(await svc.evaluate('inst')).toEqual([])
  })
})

describe('actions and tiers', () => {
  it('deactivates the instance when the rule says so', async () => {
    const svc = await service(runtimeWith([lossRule({ action: 'deactivate' })], LIVE, window({ net: -900 })))
    const trips = await svc.evaluate('inst')
    expect(deactivated).toEqual(['inst'])
    expect(trips[0]).toMatchObject({ action: 'deactivate', applied: true })
  })

  it('records the trip even when the deactivation itself fails', async () => {
    const rt = runtimeWith([lossRule({ action: 'deactivate' })], LIVE, window({ net: -900 }))
    ;(rt as unknown as { deactivate: () => Promise<void> }).deactivate = async () => { throw new Error('busy') }
    const trips = await (await service(rt)).evaluate('inst')
    expect(trips[0]).toMatchObject({ action: 'deactivate', applied: false })
  })

  it('a mild alert tier and a severe stop tier both fire on the same pass', async () => {
    const svc = await service(runtimeWith([
      lossRule({ id: 'warn', below: -50, action: 'alert' }),
      lossRule({ id: 'stop', below: -500, action: 'deactivate' }),
    ], LIVE, window({ net: -900 })))
    const trips = await svc.evaluate('inst')
    expect(trips.map(t => t.ruleId).sort()).toEqual(['stop', 'warn'])
    expect(deactivated).toEqual(['inst'])
  })

  it('two deactivate rules stop the instance once, not twice', async () => {
    const svc = await service(runtimeWith([
      lossRule({ id: 'a', below: -100, action: 'deactivate' }),
      lossRule({ id: 'b', below: -500, action: 'deactivate' }),
    ], LIVE, window({ net: -900 })))
    await svc.evaluate('inst')
    expect(deactivated).toEqual(['inst'])
  })
})

describe('alert cooldown', () => {
  it('does not repeat the same alert inside its cooldown', async () => {
    const svc = await service(runtimeWith([lossRule({ cooldownMin: 60 })], LIVE, window({ net: -80 })))
    expect(await svc.evaluate('inst')).toHaveLength(1)
    expect(await svc.evaluate('inst')).toHaveLength(0)
  })

  it('a zero cooldown means every pass alerts', async () => {
    const svc = await service(runtimeWith([lossRule({ cooldownMin: 0 })], LIVE, window({ net: -80 })))
    expect(await svc.evaluate('inst')).toHaveLength(1)
    expect(await svc.evaluate('inst')).toHaveLength(1)
  })
})

describe('arming', () => {
  it('an instance with breakerEnabled off is never evaluated', async () => {
    const svc = await service(runtimeWith([lossRule({ action: 'deactivate' })], LIVE, window({ net: -9999 }), false))
    expect(await svc.evaluate('inst')).toEqual([])
    expect(deactivated).toEqual([])
  })

  it('breakerEnabled on with no rules does nothing', async () => {
    const svc = await service(runtimeWith([], LIVE, window({ net: -9999 })))
    expect(await svc.evaluate('inst')).toEqual([])
  })
})

describe('trip history', () => {
  it('is readable newest first and carries the reading that caused it', async () => {
    const svc = await service(runtimeWith([lossRule({ cooldownMin: 0 })], LIVE,
      window({ net: -80, realized: -70, fees: -10, fills: 6, closingFills: 3, wins: 1 })))
    await svc.evaluate('inst')
    const [t] = await svc.trips()
    expect(t).toMatchObject({ instanceId: 'inst', instanceName: 'Test Instance', observed: -80, applied: true })
    expect(t!.detail).toContain('6 fills')
    expect(t!.detail).toContain('3 closing')
  })
})
