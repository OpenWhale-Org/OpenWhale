import { z } from 'zod'

/**
 * Zod mirror of ExchangeTrade — the emitSchema for monitors that emit trades
 * (e.g. hyperliquid's UserTradesMonitor). Kept next to the domain types so
 * every venue package shares one declaration.
 */
export const exchangeTradeSchema = z.object({
  id: z.string(),
  symbol: z.string().meta({ description: "Market symbol, e.g. 'BTC/USDC:USDC'" }),
  side: z.enum(['buy', 'sell']),
  price: z.number(),
  amount: z.number().meta({ description: 'Trade size in base units' }),
  cost: z.number().meta({ description: 'price × amount (USD notional)' }),
  timestamp: z.number().meta({ description: 'Unix ms' }),
  fee: z.object({ cost: z.number(), currency: z.string() }).optional(),
  takerOrMaker: z.enum(['taker', 'maker']),
  info: z.unknown().optional().meta({ description: 'Raw venue payload' }),
})
