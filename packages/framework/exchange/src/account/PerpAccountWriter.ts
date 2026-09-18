import { z } from 'zod'
import type { AccountActionDef, AccountActionOptionsContext } from '@openwhaleorg/core'
import type { PerpExchangeAdapter } from '../types/perp.js'
import type { ExchangeOrder } from '../types/exchange.js'

/**
 * Write view of a perp-venue credential — the operator half of the
 * 'exchange/perp' kind, and the counterpart to PerpAccount's reads.
 *
 * This object is NEVER handed to a strategy. Strategy order flow still travels
 * instruction → queue → executor; these methods run on a human click from the
 * Accounts page, and the runtime writes every call to the executions log so a
 * manual order is as auditable as an automated one.
 *
 * Venue subclasses may extend `actions` and add methods; the runtime matches an
 * action to a method by id, and definePlugin refuses a declaration with no
 * method behind it.
 */
export class PerpAccountWriter {
  static readonly actions: readonly AccountActionDef[] = [
    {
      id: 'placeOrder',
      group: { en: 'Order', 'zh-CN': '下单' },
      displayName: { en: 'Place order', 'zh-CN': '下单' },
      description: {
        en: 'Send a market or limit order. Amount is in base units, not USD notional.',
        'zh-CN': '发送市价或限价单。数量是标的单位，不是美元名义。',
      },
      danger: true,
      submitLabel: { en: 'Send order', 'zh-CN': '发送订单' },
      paramsSchema: z.object({
        symbol: z.string().min(1).meta({
          displayName: 'Symbol',
          i18n: { 'zh-CN': { displayName: '合约' } },
          catalogue: { source: 'market', kind: 'exchange/perp', marketType: 'swap' },
        }),
        side: z.enum(['buy', 'sell']).meta({
          displayName: 'Side',
          description: 'buy increases long exposure; sell increases short',
          i18n: { 'zh-CN': { displayName: '方向', description: 'buy 增加多头敞口，sell 增加空头' } },
        }),
        type: z.enum(['market', 'limit']).default('market').meta({
          displayName: 'Type',
          i18n: { 'zh-CN': { displayName: '类型' } },
        }),
        amount: z.number().positive().meta({
          displayName: 'Amount',
          description: 'Base units (contracts on venues that quote in contracts), not USD',
          i18n: { 'zh-CN': { displayName: '数量', description: '标的单位（合约计价的交易所为张数），不是美元' } },
        }),
        price: z.number().positive().optional().meta({
          displayName: 'Price',
          description: 'Required for limit orders',
          displayOptions: { show: { type: ['limit'] } },
          i18n: { 'zh-CN': { displayName: '价格', description: '限价单必填' } },
        }),
        reduceOnly: z.boolean().default(false).meta({
          displayName: 'Reduce only',
          description: 'Can only shrink an existing position — never opens or flips one',
          i18n: { 'zh-CN': { displayName: '只减仓', description: '只能减少已有仓位，不会开新仓或反向' } },
        }),
        positionSide: z.enum(['long', 'short']).optional().meta({
          displayName: 'Position side',
          description: 'Hedge-mode accounts require this; leave empty on one-way accounts',
          i18n: { 'zh-CN': { displayName: '持仓方向', description: '双向持仓账户必填；单向持仓留空' } },
        }),
        timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'PO']).optional().meta({
          displayName: 'Time in force',
          displayOptions: { show: { type: ['limit'] } },
          i18n: { 'zh-CN': { displayName: '有效方式' } },
        }),
        triggerPrice: z.number().positive().optional().meta({
          displayName: 'Trigger price',
          description: 'Makes this a stop order: it rests inert until the market touches this price',
          i18n: { 'zh-CN': { displayName: '触发价', description: '填写后成为条件单，市价触及此价才激活' } },
        }),
      }),
      paramOptions: (ctx) => perpMarketOptions(ctx),
    },
    {
      id: 'closePosition',
      group: { en: 'Position', 'zh-CN': '持仓' },
      displayName: { en: 'Close position', 'zh-CN': '平仓' },
      description: {
        en: 'Market-close a position, whole or in part. Always reduce-only, so it cannot flip you.',
        'zh-CN': '市价平掉一个持仓，可以只平一部分。始终只减仓，不会反向开仓。',
      },
      danger: true,
      submitLabel: { en: 'Close', 'zh-CN': '平掉' },
      paramsSchema: z.object({
        symbol: z.string().min(1).meta({
          displayName: 'Position',
          i18n: { 'zh-CN': { displayName: '持仓' } },
        }),
        positionSide: z.enum(['long', 'short']).optional().meta({
          displayName: 'Position side',
          description: 'Hedge-mode accounts only; leave empty on one-way accounts',
          i18n: { 'zh-CN': { displayName: '持仓方向', description: '仅双向持仓账户需要；单向持仓留空' } },
        }),
        percent: z.number().min(0.01).max(100).default(100).meta({
          displayName: 'Percent',
          unit: '%',
          slider: { min: 1, max: 100, step: 1 },
          description: 'Share of the position to close',
          i18n: { 'zh-CN': { displayName: '平仓比例', description: '平掉持仓的百分比' } },
        }),
      }),
      paramOptions: (ctx) => perpPositionOptions(ctx),
    },
    {
      id: 'cancelOrder',
      group: { en: 'Order', 'zh-CN': '下单' },
      displayName: { en: 'Cancel order', 'zh-CN': '撤单' },
      submitLabel: { en: 'Cancel it', 'zh-CN': '撤销' },
      paramsSchema: z.object({
        orderId: z.string().min(1).meta({
          displayName: 'Order',
          i18n: { 'zh-CN': { displayName: '订单' } },
        }),
        symbol: z.string().min(1).meta({
          displayName: 'Symbol',
          description: 'Market the order sits on — most venues need it to find the order',
          i18n: { 'zh-CN': { displayName: '合约', description: '订单所在市场，多数交易所需要它才能定位订单' } },
        }),
      }),
      paramOptions: (ctx) => openOrderOptions(ctx),
    },
    {
      id: 'cancelAllOrders',
      group: { en: 'Order', 'zh-CN': '下单' },
      displayName: { en: 'Cancel all orders', 'zh-CN': '全部撤单' },
      description: {
        en: 'Cancel every resting order, on one market or across the account.',
        'zh-CN': '撤销所有挂单，可限定单个市场或整个账户。',
      },
      danger: true,
      submitLabel: { en: 'Cancel all', 'zh-CN': '全部撤销' },
      paramsSchema: z.object({
        symbol: z.string().optional().meta({
          displayName: 'Symbol',
          description: 'Leave empty to cancel across every market',
          i18n: { 'zh-CN': { displayName: '合约', description: '留空则撤销全部市场的挂单' } },
        }),
      }),
      paramOptions: (ctx) => openOrderSymbolOptions(ctx),
    },
    {
      id: 'setLeverage',
      group: { en: 'Margin', 'zh-CN': '保证金' },
      displayName: { en: 'Set leverage', 'zh-CN': '设置杠杆' },
      description: {
        en: 'Change the leverage, and optionally the margin mode, for one market.',
        'zh-CN': '修改某个市场的杠杆倍数，可一并切换保证金模式。',
      },
      submitLabel: { en: 'Apply', 'zh-CN': '应用' },
      paramsSchema: z.object({
        symbol: z.string().min(1).meta({
          displayName: 'Symbol',
          i18n: { 'zh-CN': { displayName: '合约' } },
          catalogue: { source: 'market', kind: 'exchange/perp', marketType: 'swap' },
        }),
        leverage: z.number().int().positive().max(200).meta({
          displayName: 'Leverage',
          unit: 'x',
          i18n: { 'zh-CN': { displayName: '杠杆' } },
        }),
        marginMode: z.enum(['cross', 'isolated']).optional().meta({
          displayName: 'Margin mode',
          description: 'cross shares account margin; isolated dedicates margin per position',
          i18n: { 'zh-CN': { displayName: '保证金模式', description: 'cross 共享账户保证金，isolated 每个仓位独立' } },
        }),
      }),
      paramOptions: (ctx) => perpMarketOptions(ctx),
    },
  ]

  constructor(
    readonly name: string,
    protected readonly session: PerpExchangeAdapter,
  ) {}

  async placeOrder(p: {
    symbol: string
    side: 'buy' | 'sell'
    type: 'market' | 'limit'
    amount: number
    price?: number
    reduceOnly?: boolean
    positionSide?: 'long' | 'short'
    timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'PO'
    triggerPrice?: number
  }): Promise<ExchangeOrder> {
    if (p.type === 'limit' && p.price === undefined) throw new Error('A limit order needs a price')
    // Venues reject off-lot amounts, and the rejection reads as a generic
    // parameter error — round here so the operator never has to guess the lot.
    const amount = await this.session.amountToPrecision(p.symbol, p.amount)
    if (!(amount > 0)) throw new Error(`Amount ${p.amount} rounds to zero at this market's lot size`)
    const price = p.price !== undefined && this.session.priceToPrecision
      ? await this.session.priceToPrecision(p.symbol, p.price)
      : p.price
    return this.session.createOrder({
      symbol: p.symbol,
      side: p.side,
      type: p.type,
      amount,
      ...(price !== undefined ? { price } : {}),
      ...(p.reduceOnly ? { reduceOnly: true } : {}),
      ...(p.positionSide !== undefined ? { positionSide: p.positionSide } : {}),
      ...(p.timeInForce !== undefined ? { timeInForce: p.timeInForce } : {}),
      ...(p.triggerPrice !== undefined ? { triggerPrice: p.triggerPrice } : {}),
    })
  }

  /**
   * Market-close a position by reading its live size, so the operator never
   * types a contract count. Always reduce-only: a stale read can then only
   * under-close, never flip the position to the other side.
   */
  async closePosition(p: { symbol: string; positionSide?: 'long' | 'short'; percent?: number }): Promise<ExchangeOrder> {
    const positions = await this.session.fetchPositions([p.symbol])
    const held = positions.find(pos =>
      pos.symbol === p.symbol && pos.contracts > 0
      && (p.positionSide === undefined || pos.side === p.positionSide))
    if (!held) throw new Error(`No open position on ${p.symbol}${p.positionSide ? ` (${p.positionSide})` : ''}`)

    const share = (p.percent ?? 100) / 100
    const amount = await this.session.amountToPrecision(p.symbol, held.contracts * share)
    if (!(amount > 0)) throw new Error(`${p.percent ?? 100}% of this position rounds to zero at the market's lot size`)
    return this.session.createOrder({
      symbol: p.symbol,
      side: held.side === 'long' ? 'sell' : 'buy',
      type: 'market',
      amount,
      reduceOnly: true,
      ...(held.side !== undefined && this.session.supportsPositionSide ? { positionSide: held.side } : {}),
    })
  }

  async cancelOrder(p: { orderId: string; symbol: string }): Promise<{ orderId: string }> {
    await this.session.cancelOrder(p.orderId, p.symbol)
    return { orderId: p.orderId }
  }

  async cancelAllOrders(p: { symbol?: string }): Promise<{ symbol?: string }> {
    await this.session.cancelAllOrders(p.symbol)
    return p.symbol !== undefined ? { symbol: p.symbol } : {}
  }

  async setLeverage(p: { symbol: string; leverage: number; marginMode?: 'cross' | 'isolated' }): Promise<{ symbol: string; leverage: number; marginMode?: string }> {
    // Margin mode first: several venues refuse a mode switch while leverage is
    // mid-change, and Hyperliquid wants the leverage alongside the mode.
    if (p.marginMode !== undefined) await this.session.setMarginMode(p.symbol, p.marginMode, { leverage: p.leverage })
    await this.session.setLeverage(p.symbol, p.leverage)
    return { symbol: p.symbol, leverage: p.leverage, ...(p.marginMode !== undefined ? { marginMode: p.marginMode } : {}) }
  }
}

// ── Live option resolvers ─────────────────────────────────────────────────────
//
// Each one narrows a field to what the account actually has right now, so the
// operator picks a real position or a real order instead of retyping an id.
// Every resolver is advisory: the runtime swallows a failure and the field
// degrades to a plain input.

function perp(ctx: AccountActionOptionsContext): PerpExchangeAdapter {
  return ctx.session as PerpExchangeAdapter
}

/**
 * Held symbols, so `setLeverage` and a follow-up order default to markets the
 * account is already in. The full catalogue stays reachable through the symbol
 * picker — thousands of markets do not belong in a dropdown.
 */
async function perpMarketOptions(ctx: AccountActionOptionsContext): Promise<Record<string, Array<{ label: string; value: string }>>> {
  const positions = await perp(ctx).fetchPositions()
  const held = positions.filter(p => p.contracts > 0)
  if (held.length === 0) return {}
  return { symbol: held.map(p => ({ label: `${p.symbol} · ${p.side}`, value: p.symbol })) }
}

async function perpPositionOptions(ctx: AccountActionOptionsContext): Promise<Record<string, Array<{ label: string; value: string }>>> {
  const positions = await perp(ctx).fetchPositions()
  const held = positions.filter(p => p.contracts > 0)
  return {
    symbol: held.map(p => ({
      label: `${p.symbol} · ${p.side} · ${p.contracts} (${p.notional >= 0 ? '' : '-'}$${Math.abs(p.notional).toLocaleString(undefined, { maximumFractionDigits: 0 })})`,
      value: p.symbol,
    })),
  }
}

async function openOrderOptions(ctx: AccountActionOptionsContext): Promise<Record<string, Array<{ label: string; value: string }>>> {
  const orders = await (ctx.session as PerpExchangeAdapter).fetchOpenOrders()
  return {
    orderId: orders.map(o => ({ label: `${o.symbol} · ${o.side} ${o.amount} @ ${o.price} · ${o.id}`, value: o.id })),
    symbol: [...new Set(orders.map(o => o.symbol))].map(s => ({ label: s, value: s })),
  }
}

async function openOrderSymbolOptions(ctx: AccountActionOptionsContext): Promise<Record<string, Array<{ label: string; value: string }>>> {
  const orders = await (ctx.session as PerpExchangeAdapter).fetchOpenOrders()
  const symbols = [...new Set(orders.map(o => o.symbol))]
  if (symbols.length === 0) return {}
  return { symbol: symbols.map(s => ({ label: s, value: s })) }
}
