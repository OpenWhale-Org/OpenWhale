import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { TriggerManager } from '../TriggerManager.js'
import { MockQueue, MockStrategy, MockMonitor } from './mocks.js'
import type { Trigger } from '../../types/trigger.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTrigger(partial: Partial<Trigger> & Pick<Trigger, 'conditions'>): Trigger {
  return {
    id: 'trigger-1',
    strategyBundleId: 'bundle-1',
    enabled: true,
    ...partial,
  }
}

function makeInstruction() {
  return { executorId: 'trade', messageId: '', action: 'buy', params: {} }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('TriggerManager', () => {
  let manager: TriggerManager
  let queue: MockQueue
  let monitor: MockMonitor
  let strategy: MockStrategy

  beforeEach(() => {
    manager = new TriggerManager()
    queue = new MockQueue()
    monitor = new MockMonitor('price')
    strategy = new MockStrategy({ id: 'test', monitors: ['price'], instructions: [makeInstruction()] })
    manager.registerMonitor(monitor)
  })

  afterEach(() => {
    manager.stop()
  })

  // ── Monitor condition ───────────────────────────────────────────────────────

  describe('monitor condition', () => {
    it('fires when monitor emits matching key', async () => {
      const trigger = makeTrigger({
        conditions: [{ type: 'monitor', sources: [{ monitorName: 'price', key: 'BTC' }] }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('BTC', { price: 50000 })

      expect(strategy.contexts).toHaveLength(1)
      expect(strategy.contexts[0]!.triggerId).toBe('trigger-1')
      expect(queue.received).toHaveLength(1)
    })

    it('does not fire for non-matching key', async () => {
      const trigger = makeTrigger({
        conditions: [{ type: 'monitor', sources: [{ monitorName: 'price', key: 'BTC' }] }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('ETH', { price: 3000 })

      expect(strategy.contexts).toHaveLength(0)
    })

    it('passes monitorData in context', async () => {
      const trigger = makeTrigger({
        conditions: [{ type: 'monitor', sources: [{ monitorName: 'price', key: 'BTC' }] }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('BTC', { price: 50000 })

      expect(strategy.contexts[0]!.monitorData['price:BTC']).toMatchObject({ price: 50000 })
    })

    it('resets state after firing so it can fire again', async () => {
      const trigger = makeTrigger({
        conditions: [{ type: 'monitor', sources: [{ monitorName: 'price', key: 'BTC' }] }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('BTC', { price: 50000 })
      await monitor.emit('BTC', { price: 51000 })

      expect(strategy.contexts).toHaveLength(2)
    })
  })

  // ── Wildcard key ────────────────────────────────────────────────────────────

  describe('wildcard key (*)', () => {
    it('fires for any key when source key is *', async () => {
      const trigger = makeTrigger({
        conditions: [{ type: 'monitor', sources: [{ monitorName: 'price', key: '*' }] }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('ETH', { price: 3000 })

      expect(strategy.contexts).toHaveLength(1)
    })

    it('includes emitted key in monitorData', async () => {
      const trigger = makeTrigger({
        conditions: [{ type: 'monitor', sources: [{ monitorName: 'price', key: '*' }] }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('SOL', { price: 150 })

      expect(strategy.contexts[0]!.monitorData['price:SOL']).toMatchObject({ price: 150 })
    })
  })

  // ── Filter ──────────────────────────────────────────────────────────────────

  describe('filter', () => {
    it('fires when filter condition is met', async () => {
      const trigger = makeTrigger({
        conditions: [{
          type: 'monitor',
          sources: [{ monitorName: 'price', key: 'BTC', filter: { field: 'price', op: 'gt', value: 40000 } }],
        }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('BTC', { price: 50000 })

      expect(strategy.contexts).toHaveLength(1)
    })

    it('does not fire when filter condition is not met', async () => {
      const trigger = makeTrigger({
        conditions: [{
          type: 'monitor',
          sources: [{ monitorName: 'price', key: 'BTC', filter: { field: 'price', op: 'gt', value: 60000 } }],
        }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('BTC', { price: 50000 })

      expect(strategy.contexts).toHaveLength(0)
    })
  })

  // ── AND conditions (window) ─────────────────────────────────────────────────

  describe('AND conditions with window', () => {
    it('fires when all conditions are satisfied within window', async () => {
      const monitor2 = new MockMonitor('volume')
      strategy = new MockStrategy({ id: 'test', monitors: ['price', 'volume'], instructions: [makeInstruction()] })
      manager.registerMonitor(monitor2)

      const trigger = makeTrigger({
        window: 5000,
        conditions: [
          { type: 'monitor', sources: [{ monitorName: 'price', key: 'BTC' }] },
          { type: 'monitor', sources: [{ monitorName: 'volume', key: 'BTC' }] },
        ],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('BTC', { price: 50000 })
      await monitor2.fire('BTC', { volume: 1000 })

      expect(strategy.contexts).toHaveLength(1)
    })

    it('does not fire when only one of two conditions is satisfied', async () => {
      const monitor2 = new MockMonitor('volume')
      strategy = new MockStrategy({ id: 'test', monitors: ['price', 'volume'], instructions: [] })
      manager.registerMonitor(monitor2)

      const trigger = makeTrigger({
        window: 5000,
        conditions: [
          { type: 'monitor', sources: [{ monitorName: 'price', key: 'BTC' }] },
          { type: 'monitor', sources: [{ monitorName: 'volume', key: 'BTC' }] },
        ],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('BTC', { price: 50000 })
      // volume monitor never emits

      expect(strategy.contexts).toHaveLength(0)
    })
  })

  // ── Cron condition ──────────────────────────────────────────────────────────

  describe('cron condition', () => {
    it('fires when cron ticks', async () => {
      vi.useFakeTimers()
      strategy = new MockStrategy({ id: 'test', monitors: [], instructions: [makeInstruction()] })

      const trigger = makeTrigger({
        conditions: [{ type: 'cron', expression: '* * * * *' }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      // Advance time by 1 minute to trigger cron
      await vi.advanceTimersByTimeAsync(60_000)

      expect(strategy.contexts.length).toBeGreaterThanOrEqual(1)
      vi.useRealTimers()
    })
  })

  // ── Disabled trigger ────────────────────────────────────────────────────────

  describe('disabled trigger', () => {
    it('does not fire when trigger is disabled', async () => {
      const trigger = makeTrigger({
        enabled: false,
        conditions: [{ type: 'monitor', sources: [{ monitorName: 'price', key: 'BTC' }] }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('BTC', { price: 50000 })

      expect(strategy.contexts).toHaveLength(0)
    })
  })

  // ── unregisterBundle ────────────────────────────────────────────────────────

  describe('unregisterBundle', () => {
    it('stops firing after bundle is unregistered', async () => {
      const trigger = makeTrigger({
        conditions: [{ type: 'monitor', sources: [{ monitorName: 'price', key: 'BTC' }] }],
      })
      manager.registerBundle('bundle-1', [trigger], strategy)
      manager.start(queue)

      await monitor.fire('BTC', { price: 50000 })
      expect(strategy.contexts).toHaveLength(1)

      manager.unregisterBundle('bundle-1')
      await monitor.emit('BTC', { price: 51000 })
      expect(strategy.contexts).toHaveLength(1)
    })
  })

  // ── Missing monitor dependency ──────────────────────────────────────────────

  describe('dependency validation', () => {
    it('throws on start if declared monitor is not registered', () => {
      const missingStrategy = new MockStrategy({ id: 'test', monitors: ['nonexistent'] })
      const trigger = makeTrigger({
        conditions: [{ type: 'cron', expression: '* * * * *' }],
      })
      manager.registerBundle('bundle-1', [trigger], missingStrategy)

      expect(() => manager.start(queue)).toThrow(/nonexistent.*not registered/i)
    })
  })
})
