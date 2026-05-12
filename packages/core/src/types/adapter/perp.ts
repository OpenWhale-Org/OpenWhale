import type { ExchangePosition, ExchangeOrder, FundingRateData, PerpOrderParams } from './exchange.js'
import type { SpotExchangeAdapter } from './spot.js'

/**
 * 永续合约交易所 Adapter
 *
 * 继承 SpotExchangeAdapter 的全部能力，额外提供永续合约特有的接口：
 * 资金费率查询、持仓管理、杠杆/保证金模式设置。
 *
 * createOrder 参数升级为 PerpOrderParams，支持 reduceOnly 和 timeInForce。
 *
 * 已知实现：
 * - HyperliquidAdapter（packages/hyperliquid）
 */
export interface PerpExchangeAdapter extends SpotExchangeAdapter {
  // ── 行情（永续特有） ───────────────────────────────────────────────────────

  /**
   * 获取单个合约的当期资金费率
   * 注意：部分交易所（如 Hyperliquid）不支持单独查询，实现层会从批量接口中筛选
   */
  fetchFundingRate(symbol: string): Promise<FundingRateData>

  /** 批量获取所有合约的资金费率，推荐优先使用此接口以减少请求次数 */
  fetchFundingRates(): Promise<FundingRateData[]>

  // ── 账户（永续特有） ───────────────────────────────────────────────────────

  /**
   * 获取持仓列表
   * @param symbols 指定合约列表，为空时返回所有持仓（含空仓位，由实现决定是否过滤）
   */
  fetchPositions(symbols?: string[]): Promise<ExchangePosition[]>

  /** 获取单个合约的持仓详情 */
  fetchPosition(symbol: string): Promise<ExchangePosition>

  // ── 交易（永续特有） ───────────────────────────────────────────────────────

  /**
   * 下单（永续版本）
   * 支持 reduceOnly（只减仓）和 timeInForce（订单有效期）
   */
  createOrder(params: PerpOrderParams): Promise<ExchangeOrder>

  /**
   * 设置杠杆倍数
   * @param params 交易所特有参数，如 Hyperliquid 的 { isCross: true }
   */
  setLeverage(symbol: string, leverage: number, params?: Record<string, unknown>): Promise<void>

  /**
   * 切换保证金模式
   * cross = 全仓（共享账户余额），isolated = 逐仓（独立保证金）
   */
  setMarginMode(symbol: string, marginMode: 'cross' | 'isolated'): Promise<void>
}
