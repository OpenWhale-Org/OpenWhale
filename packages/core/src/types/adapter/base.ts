/**
 * 通用 Adapter 基础接口
 *
 * IAdapter 是框架层的最小公约数接口，适用于任何可以"查询"和"执行"的第三方服务。
 * 具体领域（交易所、NFT 市场、预测市场等）应扩展此接口或直接定义专用接口。
 *
 * 使用场景：
 * - AI 生成的 Strategy 通过 IAdapter 调用任意外部服务，无需感知具体实现
 * - Plugin 系统注册自定义 Adapter，供 Monitor 和 Executor 复用
 */
export interface AdapterQueryOptions {
  limit?: number
  offset?: number
  [key: string]: unknown
}

export interface AdapterExecuteOptions {
  /** 试运行模式，不产生实际副作用 */
  dryRun?: boolean
  [key: string]: unknown
}

export interface IAdapter {
  readonly adapterName: string
  /** 只读查询，不产生副作用 */
  query(method: string, params: Record<string, unknown>, options?: AdapterQueryOptions): Promise<unknown>
  /** 写操作，产生副作用（下单、转账等） */
  execute(action: string, params: Record<string, unknown>, options?: AdapterExecuteOptions): Promise<unknown>
}
