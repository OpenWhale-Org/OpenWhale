/**
 * Example: MomentumStrategy
 *
 * Rule-based strategy (no LLM) — makes buy/sell decisions based on price momentum signals.
 *
 * Trigger: Subscribe-driven (fires each time PriceMonitor pushes a new price)
 *
 * Logic:
 * 1. Read the last N price records and compute short-term and long-term moving averages
 * 2. shortAvg > longAvg * threshold → buy signal
 * 3. shortAvg < longAvg / threshold → sell signal
 * 4. Otherwise hold
 *
 * Key points:
 * - baseParamsSchema declares required params (symbol); tunableParamsSchema declares tunable params (windows, threshold)
 * - triggers() dynamically generates triggers from params; called by the framework at activate()
 * - this.params accesses runtime-injected params
 * - step() caches repeated computations within a single evaluate call
 * - monitorData('price') returns the price monitor reader; use reader.readLast(key, n) to read history
 * - context.monitorData contains the monitor data that triggered this evaluate; key format is 'monitorName:symbol'
 */

import { z } from 'zod'
import { BaseStrategy } from '../src/strategy/BaseStrategy.js'
import type { StrategyContext } from '../src/types/strategy.js'
import type { ExecutionInstruction } from '../src/types/executor.js'
import type { StrategyParams } from '../src/types/instance.js'
import type { Trigger } from '../src/types/trigger.js'

interface PriceRecord {
  ts: number
  data: { price: number }
}

export class MomentumStrategy extends BaseStrategy {
  readonly strategyId = 'momentum'
  readonly monitors = ['price']

  readonly baseParamsSchema = z.object({
    symbol: z.string(),  // e.g. 'BTC', 'ETH'
  })

  readonly tunableParamsSchema = z.object({
    shortWindow: z.number().int().positive().default(5),
    longWindow:  z.number().int().positive().default(20),
    threshold:   z.number().positive().default(1.005),  // 0.5% deviation triggers signal
  })

  triggers(params: StrategyParams): Omit<Trigger, 'id' | 'strategyInstanceId'>[] {
    const symbol = params.base['symbol'] as string
    return [{
      enabled: true,
      conditions: [{
        type: 'monitor',
        sources: [{ monitorName: 'price', key: symbol }],
      }],
    }]
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    const base    = this.params.base as { symbol: string }
    const tunable = this.params.tunable as { shortWindow: number; longWindow: number; threshold: number }

    const { symbol } = base
    const { shortWindow, longWindow, threshold } = tunable

    const prices = await this.step('prices', async () => {
      const reader = this.monitorData('price')
      if (!reader) return []
      return reader.readLast(symbol, longWindow) as Promise<PriceRecord[]>
    })

    if (prices.length < longWindow) return []  // not enough data, skip

    const shortPrices = prices.slice(-shortWindow)
    const shortAvg = avg(shortPrices.map(p => p.data.price))
    const longAvg  = avg(prices.map(p => p.data.price))

    const isBullish = shortAvg > longAvg * threshold
    const isBearish = shortAvg < longAvg / threshold

    return this.when(
      isBullish,
      [makeBuy(symbol, 100)],
      this.when(
        isBearish,
        [makeSell(symbol, 0.01)],
      )
    )
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function makeBuy(symbol: string, quoteAmount: number): ExecutionInstruction {
  return { executorId: 'trade', messageId: '', action: 'buy', params: { symbol, quoteAmount } }
}

function makeSell(symbol: string, baseAmount: number): ExecutionInstruction {
  return { executorId: 'trade', messageId: '', action: 'sell', params: { symbol, baseAmount } }
}
