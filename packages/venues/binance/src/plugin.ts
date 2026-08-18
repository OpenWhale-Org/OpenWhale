import { z } from 'zod'
import { definePlugin } from '@openwhaleorg/core'
import type { RawCredentialData } from '@openwhaleorg/core'
import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import { BinanceAdapter } from './adapter.js'
import { BinancePerpAccount } from './account.js'

const buildSpot = (data: RawCredentialData) => new CcxtAdapter({
  exchangeId: 'binance',
  apiKey: data['apiKey'] as string,
  secret: data['secret'] as string,
  ...((data['testnet'] as boolean | undefined) ? { testnet: true } : {}),
})
const buildPerp = (data: RawCredentialData) => new BinanceAdapter({
  apiKey: data['apiKey'] as string,
  secret: data['secret'] as string,
  testnet: (data['testnet'] as boolean | undefined) ?? false,
  unifiedAccount: (data['unifiedAccount'] as boolean | undefined) ?? false,
})

/**
 * Binance venue plugin — a pure manifest: the 'binance' credential type
 * (schema drives the dashboard form, connectivity test) plus this venue's
 * adapter cells in the type × kind matrix. One key, two kinds — perp and spot
 * ride the same credential. Keyless cells serve public market data and are
 * ALWAYS mainnet: testnet books and rates are not a real market, so they
 * carry no signal (paper trading = real signals + the credential's testnet
 * flag). No plugin config: anything that changes how a stored credential is
 * INTERPRETED lives on the credential itself.
 */
export const binancePlugin = definePlugin({
  name: 'binance',
  version: '1.0.0',

  // Which class backs each form is the cell's internal business: the keyless
  // form is a plain ccxt public adapter, the credentialed form the venue's own.
  adapters: [
    {
      kind: 'exchange/perp', type: 'binance',
      create: (data?) => data ? buildPerp(data) : new CcxtAdapter({ exchangeId: 'binanceusdm' }),
    },
    {
      kind: 'exchange/spot', type: 'binance',
      create: (data?) => data ? buildSpot(data) : new CcxtAdapter({ exchangeId: 'binance' }),
    },
  ],

  // (exchange/perp, 'binance') specialization: Portfolio Margin equity uses
  // Binance's official actualEquity instead of the generic collateral+PnL recipe
  accounts: [BinancePerpAccount],

  credentialTypes: [
    {
      type: 'binance',
      displayName: 'Binance',
      icon: '🟡',
      description: 'Perps and spot on one key. Supports Portfolio Margin and a testnet.',
      documentationUrl: 'https://www.binance.com/en/support/faq/how-to-create-api-keys-on-binance-360002502072',
      // Raw opt-in: the funding-charge monitor needs the key itself (user-data
      // stream listenKey + signed income reads have no session equivalent).
      raw: true,
      schema: z.object({
        apiKey: z.string().meta({ displayName: 'API Key' }),
        secret: z.string().meta({ displayName: 'API Secret', password: true }),
        testnet: z.boolean().default(false).meta({ displayName: 'Testnet', description: 'Trade on testnet.binancefuture.com instead of mainnet' }),
        unifiedAccount: z.boolean().default(false).meta({
          displayName: 'Unified Account (Portfolio Margin)',
          description: 'Trade through the Portfolio Margin (papi) endpoints — shared margin across UM/CM/margin. Needs PM enabled on the account and a PM-scoped API key. Incompatible with Testnet.',
        }),
      }),
      test: async (data) => { await buildPerp(data).fetchBalance() },
    },
  ],
})

export default binancePlugin
