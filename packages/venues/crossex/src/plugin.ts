import { z } from 'zod'
import { definePlugin } from '@openwhaleorg/core'
import type { RawCredentialData } from '@openwhaleorg/core'
import { CrossExAdapter, CrossExPublicAdapter } from './adapter.js'

const build = (data: RawCredentialData) => new CrossExAdapter({
  apiKey: data['apiKey'] as string,
  apiSecret: data['apiSecret'] as string,
  ...(data['channelId'] ? { channelId: data['channelId'] as string } : {}),
})

/**
 * Gate CrossEx — one venue, one margin pool, many exchanges.
 *
 * Modelled as a single venue on purpose. CrossEx symbols name the exchange
 * they trade on (`BINANCE_SWAP_BTC_USDT`), and the collateral behind all of
 * them is one pool: a matrix row per exchange would say the opposite, and
 * would say it most confidently near liquidation, where it matters.
 *
 * ⚠️ No testnet exists. Every order placed here is live.
 */
export const crossexPlugin = definePlugin({
  name: 'crossex',
  version: '1.0.0',

  adapters: [
    {
      kind: 'exchange/perp', type: 'crossex',
      create: (data?) => data ? build(data) : new CrossExPublicAdapter(),
    },
  ],

  credentialTypes: [
    {
      type: 'crossex',
      displayName: 'Gate CrossEx',
      logo: '/brands/gate.png',
      icon: '🔀',
      description: 'One cross-exchange account over Binance, OKX, Bybit, Gate, Kraken, Hyperliquid and Deribit, with margin shared between them.',
      documentationUrl: 'https://www.gate.com/docs/developers/crossex/',
      schema: z.object({
        apiKey: z.string().min(8).meta({
          displayName: 'API Key',
          description: 'A Gate APIv4 key with CrossEx permissions. Create it under Gate → API Management, and leave withdrawal off.',
        }),
        apiSecret: z.string().min(8).meta({
          displayName: 'API Secret',
          password: true,
          description: 'Signs every request (HMAC-SHA512). Gate shows it once, at creation.',
        }),
        channelId: z.string().optional().meta({
          displayName: 'Broker Channel Id',
          placeholder: 'optional',
          description: 'Sent as X-Gate-Channel-Id on order placement, if you have a Gate broker/affiliate channel. Leave empty otherwise.',
        }),
      }),
      // Reads the account rather than the public symbol list: a key that is
      // valid but lacks CrossEx permission would pass a public call.
      test: async (data) => { await build(data).fetchBalance() },
    },
  ],
})

export default crossexPlugin
