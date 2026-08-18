import { z } from 'zod'
import { definePlugin } from '@openwhaleorg/core'
import type { RawCredentialData } from '@openwhaleorg/core'
import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import { AsterAdapter } from './adapter.js'

// Aster settles in USDT/USDF
const ASTER_STABLES = ['USDT', 'USDF', 'USDC', 'USD']
void ASTER_STABLES // account specialization with custom stables can be added when needed

const build = (data: RawCredentialData) => new AsterAdapter({
  apiKey: data['apiKey'] as string,
  secret: data['secret'] as string,
})

/**
 * Aster venue plugin — a pure manifest: the 'aster' credential type plus its
 * 'exchange/perp' adapter cell. ⚠️ Aster has no testnet — every order is live.
 */
export const asterPlugin = definePlugin({
  name: 'aster',
  version: '1.0.0',

  adapters: [
    {
      kind: 'exchange/perp', type: 'aster',
      create: (data?) => data ? build(data) : new CcxtAdapter({ exchangeId: 'aster' }),
    },
  ],

  credentialTypes: [
    {
      type: 'aster',
      displayName: 'Aster',
      logo: '/brands/aster.png',
      icon: '✳️',
      description: 'Perp DEX with a Binance-style API.',
      documentationUrl: 'https://docs.asterdex.com',
      schema: z.object({
        apiKey: z.string().meta({ displayName: 'API Key' }),
        secret: z.string().meta({ displayName: 'API Secret', password: true }),
      }),
      test: async (data) => { await build(data).fetchBalance() },
    },
  ],
})

export default asterPlugin
