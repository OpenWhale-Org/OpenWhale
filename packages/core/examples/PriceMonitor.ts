/**
 * Example: PriceMonitor
 *
 * Subscribe 模式 Monitor — 每隔 5 秒轮询一次价格接口，
 * 每个交易对（key）独立维护一个 setInterval。
 *
 * 关键点：
 * - mode = MonitorMode.Subscribe：由 TriggerManager 通过 subscribe(key) 驱动
 * - startSubscribe(key) 启动轮询，stopSubscribe(key) 清理定时器
 * - 调用 this.push(key, data) 提交数据，基类负责写 JSONL 和触发 emit
 * - 不需要手动管理引用计数，基类已处理
 */

import { BaseMonitor, MonitorMode } from '../src/monitor/BaseMonitor.js'

interface PriceData {
  price: number
  volume24h: number
  change24h: number
}

export class PriceMonitor extends BaseMonitor<string, PriceData> {
  readonly mode = MonitorMode.Subscribe

  get monitorName() {
    return 'price'
  }

  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly intervalMs: number

  constructor(intervalMs = 5000) {
    super()
    this.intervalMs = intervalMs
  }

  protected startSubscribe(key: string): void {
    // 立即执行一次，然后按间隔重复
    void this.fetchAndPush(key)
    const timer = setInterval(() => void this.fetchAndPush(key), this.intervalMs)
    this.timers.set(key, timer)
  }

  protected stopSubscribe(key: string): void {
    const timer = this.timers.get(key)
    if (timer !== undefined) {
      clearInterval(timer)
      this.timers.delete(key)
    }
  }

  private async fetchAndPush(key: string): Promise<void> {
    const data = await this.fetchPrice(key)
    await this.push(key, data)
  }

  /**
   * 实际项目中替换为真实 API 调用，例如：
   *   const res = await fetch(`https://api.exchange.com/ticker/${key}`)
   *   return res.json()
   */
  private async fetchPrice(symbol: string): Promise<PriceData> {
    // 模拟价格数据
    const base = symbol === 'BTC' ? 65000 : symbol === 'ETH' ? 3500 : 100
    return {
      price: base * (1 + (Math.random() - 0.5) * 0.02),
      volume24h: Math.random() * 1e9,
      change24h: (Math.random() - 0.5) * 10,
    }
  }
}
