import { z } from 'zod'
import type { AccountActionDef, AccountActionOptionsContext } from '@openwhaleorg/core'
import type { SpotExchangeAdapter } from '../types/spot.js'
import type { ExchangeOrder } from '../types/exchange.js'

/**
 * Write view of a spot-venue credential — the operator half of the
 * 'exchange/spot' kind, and the counterpart to SpotAccount's reads.
 *
 * Spot has no positions and no leverage, so the surface is narrower than the
 * perp one by nature rather than by omission: you buy, you sell, you cancel.
 * As with the perp writer this object never reaches a strategy, and every call
 * is recorded to the executions log.
 */
export class SpotAccountWriter {
  static readonly actions: readonly AccountActionDef[] = [
    {
      id: 'placeOrder',
      group: { en: 'Order', 'zh-CN': '下单' },
      displayName: { en: 'Place order', 'zh-CN': '下单' },
      description: {
        en: 'Send a market or limit order. Amount is in base units — 0.5 ETH, not $2,000.',
        'zh-CN': '发送市价或限价单。数量是标的单位，比如 0.5 ETH，不是 2000 美元。',
      },
      danger: true,
      submitLabel: { en: 'Send order', 'zh-CN': '发送订单' },
      paramsSchema: z.object({
        symbol: z.string().min(1).meta({
          displayName: 'Symbol',
          i18n: { 'zh-CN': { displayName: '交易对' } },
          catalogue: { source: 'market', kind: 'exchange/spot', marketType: 'spot' },
        }),
        side: z.enum(['buy', 'sell']).meta({
          displayName: 'Side',
          i18n: { 'zh-CN': { displayName: '方向' } },
        }),
        type: z.enum(['market', 'limit']).default('market').meta({
          displayName: 'Type',
          i18n: { 'zh-CN': { displayName: '类型' } },
        }),
        amount: z.number().positive().meta({
          displayName: 'Amount',
          description: 'Base units of the pair, e.g. the ETH in ETH/USDT',
          i18n: { 'zh-CN': { displayName: '数量', description: '交易对的标的数量，例如 ETH/USDT 里的 ETH' } },
        }),
        price: z.number().positive().optional().meta({
          displayName: 'Price',
          description: 'Required for limit orders',
          displayOptions: { show: { type: ['limit'] } },
          i18n: { 'zh-CN': { displayName: '价格', description: '限价单必填' } },
        }),
      }),
      paramOptions: (ctx) => heldTokenPairOptions(ctx),
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
          description: 'Pair the order sits on — most venues need it to find the order',
          i18n: { 'zh-CN': { displayName: '交易对', description: '订单所在市场，多数交易所需要它才能定位订单' } },
        }),
      }),
      paramOptions: (ctx) => openOrderOptions(ctx),
    },
    {
      id: 'cancelAllOrders',
      group: { en: 'Order', 'zh-CN': '下单' },
      displayName: { en: 'Cancel all orders', 'zh-CN': '全部撤单' },
      description: {
        en: 'Cancel every resting order, on one pair or across the account.',
        'zh-CN': '撤销所有挂单，可限定单个交易对或整个账户。',
      },
      danger: true,
      submitLabel: { en: 'Cancel all', 'zh-CN': '全部撤销' },
      paramsSchema: z.object({
        symbol: z.string().optional().meta({
          displayName: 'Symbol',
          description: 'Leave empty to cancel across every pair',
          i18n: { 'zh-CN': { displayName: '交易对', description: '留空则撤销全部交易对的挂单' } },
        }),
      }),
      paramOptions: (ctx) => openOrderSymbolOptions(ctx),
    },
  ]

  constructor(
    readonly name: string,
    protected readonly session: SpotExchangeAdapter,
  ) {}

  async placeOrder(p: {
    symbol: string
    side: 'buy' | 'sell'
    type: 'market' | 'limit'
    amount: number
    price?: number
  }): Promise<ExchangeOrder> {
    if (p.type === 'limit' && p.price === undefined) throw new Error('A limit order needs a price')
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
}

// ── Live option resolvers ─────────────────────────────────────────────────────

function spot(ctx: AccountActionOptionsContext): SpotExchangeAdapter {
  return ctx.session as SpotExchangeAdapter
}

/**
 * Pairs the account can act on right now: whatever it already has open orders
 * in. The full catalogue stays reachable through the symbol picker — a spot
 * venue lists thousands of pairs, which is a search box, not a dropdown.
 */
async function heldTokenPairOptions(ctx: AccountActionOptionsContext): Promise<Record<string, Array<{ label: string; value: string }>>> {
  const orders = await spot(ctx).fetchOpenOrders()
  const symbols = [...new Set(orders.map(o => o.symbol))]
  if (symbols.length === 0) return {}
  return { symbol: symbols.map(s => ({ label: s, value: s })) }
}

async function openOrderOptions(ctx: AccountActionOptionsContext): Promise<Record<string, Array<{ label: string; value: string }>>> {
  const orders = await spot(ctx).fetchOpenOrders()
  return {
    orderId: orders.map(o => ({ label: `${o.symbol} · ${o.side} ${o.amount} @ ${o.price} · ${o.id}`, value: o.id })),
    symbol: [...new Set(orders.map(o => o.symbol))].map(s => ({ label: s, value: s })),
  }
}

async function openOrderSymbolOptions(ctx: AccountActionOptionsContext): Promise<Record<string, Array<{ label: string; value: string }>>> {
  const orders = await spot(ctx).fetchOpenOrders()
  const symbols = [...new Set(orders.map(o => o.symbol))]
  if (symbols.length === 0) return {}
  return { symbol: symbols.map(s => ({ label: s, value: s })) }
}
