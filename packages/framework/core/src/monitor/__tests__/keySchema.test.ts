import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { BaseMonitor, MonitorMode } from '../BaseMonitor.js'

class KlinesMonitor extends BaseMonitor<string, { close: number }> {
  override readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'klines' }
  override get keySchema() {
    return z.object({
      venue: z.string(),
      symbol: z.string(),
      timeframe: z.string().default('1m'),
    })
  }
  protected override startSubscribe(): void {}
  protected override stopSubscribe(): void {}
}

class KeylessMonitor extends BaseMonitor<string, Record<string, unknown>> {
  override readonly mode = MonitorMode.Subscribe
  get monitorName() { return 'keyless' }
  protected override startSubscribe(): void {}
  protected override stopSubscribe(): void {}
}

describe('monitor keySchema', () => {
  it('keyFor joins fields with ":" in declaration order, applying defaults', () => {
    const m = new KlinesMonitor()
    expect(m.keyFor({ venue: 'binance', symbol: 'BTC/USDT:USDT', timeframe: '5m' })).toBe('binance:BTC/USDT:USDT:5m')
    expect(m.keyFor({ venue: 'binance', symbol: 'BTC/USDT:USDT' })).toBe('binance:BTC/USDT:USDT:1m')
  })

  it('keyFor validates params against the schema', () => {
    const m = new KlinesMonitor()
    expect(() => m.keyFor({ venue: 'binance' })).toThrow()
  })

  it('keyFor without a keySchema points at raw keys', () => {
    expect(() => new KeylessMonitor().keyFor({ a: 1 })).toThrow(/no keySchema/)
  })
})
