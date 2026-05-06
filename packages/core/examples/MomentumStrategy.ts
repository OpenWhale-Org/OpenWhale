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
 * - step() 缓存同一次 evaluate 内的重复计算
 * - monitorData(key) 获取 MonitorDataReader，读取历史数据
 * - when() / rule() 是语义化的条件包装，等价于三元表达式
 * - forEach() 对多个交易对批量生成指令
 * - monitorData('price') 返回 price monitor 的 reader，通过 reader.readLast(symbol, n) 读取历史数据
 * - context.monitorData 包含触发本次 evaluate 的 monitor 数据，key 格式为 'monitorName:symbol'
 * - 从 monitorData 的 key 中解析出交易对 symbol
 */

import { BaseStrategy } from '../src/strategy/BaseStrategy.js'
import type { StrategyContext } from '../src/types/strategy.js'
import type { ExecutionInstruction } from '../src/types/executor.js'

interface PriceRecord {
  ts: number
  price: number
}

export class MomentumStrategy extends BaseStrategy {
  readonly strategyId = 'momentum'
  readonly monitors = ['price']

  private readonly shortWindow: number
  private readonly longWindow: number
  private readonly threshold: number

  constructor(options?: {
    shortWindow?: number
    longWindow?: number
    threshold?: number
  }) {
    super()
    this.shortWindow = options?.shortWindow ?? 5
    this.longWindow = options?.longWindow ?? 20
    this.threshold = options?.threshold ?? 1.005  // 0.5% 偏差触发
  }

  async evaluate(context: StrategyContext): Promise<ExecutionInstruction[]> {
    // Derive symbol from monitorData key ('price:BTC' → 'BTC')
    const priceKey = Object.keys(context.monitorData).find(k => k.startsWith('price:'))
    const symbol = priceKey?.split(':')[1]
    if (!symbol) return []

    const prices = await this.step('prices', async () => {
      const reader = this.monitorData('price')
      if (!reader) return []
      return reader.readLast(symbol, this.longWindow) as Promise<PriceRecord[]>
    })

    if (prices.length < this.longWindow) return []  // 数据不足，跳过

    const shortPrices = prices.slice(-this.shortWindow)
    const shortAvg = avg(shortPrices.map(p => p.price))
    const longAvg = avg(prices.map(p => p.price))

    const isBullish = shortAvg > longAvg * this.threshold
    const isBearish = shortAvg < longAvg / this.threshold

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
  return {
    executorId: 'trade',
    messageId: '',
    action: 'buy',
    params: { symbol, quoteAmount },
  }
}

function makeSell(symbol: string, baseAmount: number): ExecutionInstruction {
  return {
    executorId: 'trade',
    messageId: '',
    action: 'sell',
    params: { symbol, baseAmount },
  }
}
