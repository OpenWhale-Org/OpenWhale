/**
 * Example: MomentumStrategy
 *
 * 纯规则策略（无 LLM）— 基于价格动量信号决定买卖。
 *
 * 触发方式：Subscribe 触发（PriceMonitor 每次推送新价格时触发）
 *
 * 逻辑：
 * 1. 读取最近 N 条价格记录，计算短期均价和长期均价
 * 2. 短期均价 > 长期均价 * threshold → 买入信号
 * 3. 短期均价 < 长期均价 / threshold → 卖出信号
 * 4. 否则持仓不动
 *
 * 关键点：
 * - baseParamsSchema 声明必填参数（symbol），tunableParamsSchema 声明可调参数（窗口、阈值）
 * - triggers() 根据 params 动态生成触发器，框架在 activate() 时调用
 * - this.params 访问运行时注入的参数
 * - step() 缓存同一次 evaluate 内的重复计算
 * - monitorData('price') 返回 price monitor 的 reader，通过 reader.readLast(key, n) 读取历史数据
 * - context.monitorData 包含触发本次 evaluate 的 monitor 数据，key 格式为 'monitorName:symbol'
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
    threshold:   z.number().positive().default(1.005),  // 0.5% 偏差触发
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

    if (prices.length < longWindow) return []  // 数据不足，跳过

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
