import fs from 'fs'
import path from 'path'
import type { EmitHandler, MonitorDataReader, MonitorOptions } from '../types/monitor.js'
import { getDataDir, getMonitorPath } from '../utils/paths.js'
import { MonitorDataReaderImpl } from './MonitorDataReader.js'

/**
 * Standalone — 只能独立运行，不支持 subscribe 驱动
 * Subscribe  — 只能被 subscribe 驱动，不支持独立运行
 * Any        — 两种方式均支持
 */
export enum MonitorMode {
  Standalone = 'standalone',
  Subscribe = 'subscribe',
  Any = 'any',
}

/**
 * @ai-guide 如何编写一个 Monitor
 *
 * 1. 确定运行模式（mode）：
 *    - MonitorMode.Subscribe：数据由外部 key 驱动（如 REST 轮询），覆盖 startSubscribe/stopSubscribe
 *    - MonitorMode.Standalone：Monitor 自行管理连接（如 WebSocket），覆盖 startStandalone/stopStandalone
 *    - MonitorMode.Any：同时支持两种模式，覆盖全部四个方法
 *
 * 2. 定义泛型参数：
 *    - TKey：监控的 key 类型，通常是交易对、地址等字符串标识
 *    - TData：每次采集到的数据结构，不需要包含时间戳（基类自动注入 ts 字段）
 *
 * 3. 实现 monitorName：返回唯一的字符串名称，用于确定 JSONL 文件存储路径
 *
 * 4. 在 startSubscribe(key) / startStandalone() 中启动采集，
 *    每次获取到数据后调用 this.push(key, data) 提交给基类
 *
 * 5. 在 stopSubscribe(key) / stopStandalone() 中清理资源（clearInterval、关闭连接等）
 *
 * Subscribe 模式示例（REST 轮询）：
 * ```typescript
 * class PriceMonitor extends BaseMonitor<string, { price: number }> {
 *   readonly mode = MonitorMode.Subscribe
 *   get monitorName() { return 'price' }
 *   private timers = new Map<string, NodeJS.Timeout>()
 *
 *   protected startSubscribe(key: string) {
 *     const t = setInterval(async () => {
 *       const price = await fetchPrice(key)
 *       await this.push(key, { price })
 *     }, 5000)
 *     this.timers.set(key, t)
 *   }
 *   protected stopSubscribe(key: string) {
 *     clearInterval(this.timers.get(key))
 *     this.timers.delete(key)
 *   }
 * }
 * ```
 *
 * Subscribe 模式示例（单一 WebSocket 连接，按 key 订阅/退订）：
 * ```typescript
 * class TradeMonitor extends BaseMonitor<string, TradeData> {
 *   readonly mode = MonitorMode.Subscribe
 *   get monitorName() { return 'trade' }
 *   private ws?: WebSocket
 *   private subscribedKeys = new Set<string>()
 *
 *   // 确保 WS 连接存在，首次调用时建立
 *   private ensureConnected() {
 *     if (this.ws) return
 *     this.ws = new WebSocket('wss://exchange/stream')
 *     this.ws.on('message', (raw) => {
 *       const { key, ...data } = JSON.parse(raw.toString())
 *       if (this.subscribedKeys.has(key)) void this.push(key, data)
 *     })
 *     this.ws.on('open', () => {
 *       // 重连后重新订阅所有 key
 *       for (const key of this.subscribedKeys) this.sendSubscribe(key)
 *     })
 *   }
 *
 *   private sendSubscribe(key: string) {
 *     this.ws?.send(JSON.stringify({ op: 'subscribe', channel: key }))
 *   }
 *
 *   private sendUnsubscribe(key: string) {
 *     this.ws?.send(JSON.stringify({ op: 'unsubscribe', channel: key }))
 *   }
 *
 *   protected startSubscribe(key: string) {
 *     this.ensureConnected()
 *     this.subscribedKeys.add(key)
 *     this.sendSubscribe(key)
 *   }
 *
 *   protected stopSubscribe(key: string) {
 *     this.subscribedKeys.delete(key)
 *     this.sendUnsubscribe(key)
 *     // 所有 key 都退订后关闭连接
 *     if (this.subscribedKeys.size === 0) {
 *       this.ws?.close()
 *       this.ws = undefined
 *     }
 *   }
 * }
 * ```
 *
 * Standalone 模式示例（WebSocket）：
 * ```typescript
 * class OrderbookMonitor extends BaseMonitor<string, OrderbookData> {
 *   readonly mode = MonitorMode.Standalone
 *   get monitorName() { return 'orderbook' }
 *   private ws?: WebSocket
 *
 *   protected startStandalone() {
 *     this.ws = new WebSocket('wss://exchange/orderbook')
 *     this.ws.on('message', (raw) => {
 *       const { key, ...data } = JSON.parse(raw.toString())
 *       void this.push(key, data)
 *     })
 *   }
 *   protected stopStandalone() {
 *     this.ws?.close()
 *   }
 * }
 * ```
 */
export abstract class BaseMonitor<TKey extends string = string, TData = Record<string, unknown>> {
  private readonly refCounts = new Map<string, number>()
  private emitHandler?: EmitHandler<TData>
  protected readonly dataDir: string

  /**
   * 声明当前 Monitor 支持的运行模式，子类覆盖此属性。
   */
  readonly mode: MonitorMode = MonitorMode.Any

  constructor(options?: MonitorOptions) {
    this.dataDir = getDataDir(options?.dataDir)
  }

  abstract get monitorName(): string

  /**
   * 独立运行模式的启动，子类按需覆盖。
   * mode 为 Subscribe 的子类无需实现此方法。
   */
  protected startStandalone(): void {
    throw new Error(`Monitor "${this.monitorName}" does not support standalone mode`)
  }

  /**
   * 独立运行模式的停止，子类按需覆盖。
   * mode 为 Subscribe 的子类无需实现此方法。
   */
  protected stopStandalone(): void {
    throw new Error(`Monitor "${this.monitorName}" does not support standalone mode`)
  }

  /**
   * subscribe 驱动模式的启动，针对指定 key 启动采集，子类按需覆盖。
   * mode 为 Standalone 的子类无需实现此方法。
   */
  protected startSubscribe(_key: TKey): void {
    throw new Error(`Monitor "${this.monitorName}" does not support subscribe mode`)
  }

  /**
   * subscribe 驱动模式的停止，针对指定 key 停止采集，子类按需覆盖。
   * mode 为 Standalone 的子类无需实现此方法。
   */
  protected stopSubscribe(_key: TKey): void {
    throw new Error(`Monitor "${this.monitorName}" does not support subscribe mode`)
  }

  /**
   * 启动 Monitor。
   * - 无参数：独立运行模式，mode 为 Subscribe 时抛出错误
   * - 有参数：subscribe 驱动模式，mode 为 Standalone 时抛出错误
   */
  start(key?: TKey): void {
    if (key === undefined) {
      if (this.mode === MonitorMode.Subscribe) {
        throw new Error(`Monitor "${this.monitorName}" only supports subscribe mode and cannot be started standalone`)
      }
      this.startStandalone()
    } else {
      if (this.mode === MonitorMode.Standalone) {
        throw new Error(`Monitor "${this.monitorName}" only supports standalone mode and cannot be started by subscribe`)
      }
      this.startSubscribe(key)
    }
  }

  /**
   * 停止 Monitor。
   * - 无参数：停止独立运行
   * - 有参数：停止指定 key 的采集
   */
  stop(key?: TKey): void {
    if (key === undefined) {
      if (this.mode === MonitorMode.Subscribe) {
        throw new Error(`Monitor "${this.monitorName}" only supports subscribe mode`)
      }
      this.stopStandalone()
    } else {
      if (this.mode === MonitorMode.Standalone) {
        throw new Error(`Monitor "${this.monitorName}" only supports standalone mode`)
      }
      this.stopSubscribe(key)
    }
  }

  subscribe(key: TKey): void {
    if (this.mode === MonitorMode.Standalone) {
      throw new Error(`Monitor "${this.monitorName}" only supports standalone mode and cannot be subscribed`)
    }
    const count = this.refCounts.get(key) ?? 0
    this.refCounts.set(key, count + 1)
    this.onSubscribe(key)
    if (count === 0) {
      this.onFirstSubscribe(key)
    }
  }

  unsubscribe(key: TKey): void {
    const count = this.refCounts.get(key) ?? 0
    if (count <= 1) {
      this.refCounts.delete(key)
      this.onUnsubscribe(key)
      this.onLastUnsubscribe(key)
    } else {
      this.refCounts.set(key, count - 1)
      this.onUnsubscribe(key)
    }
  }

  hasSubscribers(key: string): boolean {
    return (this.refCounts.get(key) ?? 0) > 0
  }

  protected onFirstSubscribe(key: TKey): void {
    this.start(key)
  }

  protected onLastUnsubscribe(key: TKey): void {
    this.stop(key)
  }

  protected onSubscribe(_key: TKey): void {}
  protected onUnsubscribe(_key: TKey): void {}

  protected onBeforeEmit(_key: TKey, _data: TData): void {}
  protected onAfterEmit(_key: TKey, _data: TData): void {}

  /**
   * 子类采集到数据后调用此方法提交，基类负责持久化和事件分发。
   */
  protected async push(key: TKey, data: TData): Promise<void> {
    await this.append(key, data)
    await this.emit(key, data)
  }

  protected async append(key: TKey, data: TData): Promise<void> {
    const filePath = getMonitorPath(this.dataDir, this.monitorName, key)
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    const record = { ts: Date.now(), ...data }
    await fs.promises.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8')
  }

  getReader(key: TKey): MonitorDataReader<TData> {
    const filePath = getMonitorPath(this.dataDir, this.monitorName, key)
    return new MonitorDataReaderImpl<TData>(filePath)
  }

  setEmitHandler(handler: EmitHandler<TData>): void {
    this.emitHandler = handler
  }

  protected async emit(key: TKey, data: TData): Promise<void> {
    if (!this.hasSubscribers(key) && this.emitHandler === undefined) return
    this.onBeforeEmit(key, data)
    if (this.emitHandler) {
      await this.emitHandler(key, data)
    }
    this.onAfterEmit(key, data)
  }
}
