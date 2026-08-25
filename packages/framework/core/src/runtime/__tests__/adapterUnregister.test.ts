import { describe, it, expect } from 'vitest'
import { AdapterRegistry } from '../AdapterRegistry.js'
import type { NamespacedKind } from '../../types/materialization.js'

/**
 * Unregistering a plugin's cells has to finish leaving before anyone can
 * arrive — because replacing a plugin unloads it and re-registers in the same
 * breath, with nothing in between.
 *
 * The failure this pins down was invisible until a session had actually been
 * opened: only a CACHED instance gives the teardown something to await, and
 * only then does a multi-cell plugin get suspended halfway out of the table.
 */
describe('AdapterRegistry.unregisterOwner', () => {
  const RATES = 'demo/rates' as NamespacedKind
  const MARKET = 'demo/market' as NamespacedKind

  /** A venue plugin's two cells, the first of which is slow to close. */
  function twoCells(): { registry: AdapterRegistry; closed: string[] } {
    const closed: string[] = []
    const registry = new AdapterRegistry()
    registry.register('pendle', {
      kind: RATES,
      venue: 'boros',
      create: () => ({ close: async () => { await new Promise(r => setTimeout(r, 20)); closed.push('boros') } }),
    })
    registry.register('pendle', { kind: MARKET, venue: 'pendle', create: () => ({}) })
    return { registry, closed }
  }

  it('empties the table before awaiting a single close', async () => {
    const { registry } = twoCells()
    await registry.resolve(RATES, 'boros')      // cache an instance, so close() is reached

    const finished = registry.unregisterOwner('pendle')   // deliberately not awaited

    /* Both gone already. Awaiting the first cell's close inside the loop used
       to suspend here with the second still registered, so a replace re-
       registering right now was told (demo/market, pendle) was taken — by the
       very plugin being unloaded. */
    expect(registry.ownerOfCell(RATES, 'boros')).toBeUndefined()
    expect(registry.ownerOfCell(MARKET, 'pendle')).toBeUndefined()

    await finished
  })

  it('still closes the sessions it dropped', async () => {
    const { registry, closed } = twoCells()
    await registry.resolve(RATES, 'boros')
    await registry.unregisterOwner('pendle')
    expect(closed).toEqual(['boros'])
  })

  it('leaves other plugins alone', async () => {
    const { registry } = twoCells()
    registry.register('other', { kind: MARKET, venue: 'somewhere-else', create: () => ({}) })
    await registry.unregisterOwner('pendle')
    expect(registry.ownerOfCell(MARKET, 'somewhere-else')).toBe('other')
  })
})
