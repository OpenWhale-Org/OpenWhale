import { z } from 'zod'
import { definePlugin } from '@openwhaleorg/core'
import type { RawCredentialData } from '@openwhaleorg/core'
import { AsterAdapter, AsterPublicAdapter } from './adapter.js'

// Aster settles in USDT/USDF
const ASTER_STABLES = ['USDT', 'USDF', 'USDC', 'USD']
void ASTER_STABLES // account specialization with custom stables can be added when needed

const build = (data: RawCredentialData) => new AsterAdapter({
  walletAddress: data['walletAddress'] as string,
  privateKey: data['privateKey'] as string,
  ...(data['signerAddress'] ? { signerAddress: data['signerAddress'] as string } : {}),
})

/**
 * Aster venue plugin — a pure manifest: the 'aster' credential type plus its
 * 'exchange/perp' adapter cell.
 *
 * ⚠️ Aster has no testnet — every order is live.
 *
 * Credentials are an API WALLET, not an API key: ccxt 4.5.52 dropped Aster's
 * HMAC path, and v3 requests are EIP-712 signatures carrying the master
 * address as `user` and the API wallet as `signer`.
 */
export const asterPlugin = definePlugin({
  name: 'aster',
  version: '1.0.0',

  adapters: [
    {
      kind: 'exchange/perp', type: 'aster',
      create: (data?) => data ? build(data) : new AsterPublicAdapter(),
    },
  ],

  credentialTypes: [
    {
      type: 'aster',
      displayName: 'Aster',
      logo: '/brands/aster.png',
      icon: '✳️',
      description: 'Perp DEX. Signs with an API wallet — the master wallet\'s own key is never needed.',
      documentationUrl: 'https://asterdex.github.io/aster-api-website/futures-v3/general-info/',
      schema: z.object({
        walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).meta({
          displayName: 'Master Wallet Address',
          placeholder: '0x…',
          description: 'The account you log into Aster with — sent as `user`. Its private key is never needed here.',
        }),
        privateKey: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/).meta({
          displayName: 'API Wallet Private Key',
          password: true,
          description: 'Create the API wallet at asterdex.com/en/api-wallet (switch to Pro API). It signs on the master account\'s behalf and cannot withdraw.',
        }),
        signerAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().meta({
          displayName: 'API Wallet Address',
          placeholder: 'derived from the private key',
          description: 'Sent as `signer`. Leave empty — it is the private key\'s own address.',
        }),
      }),
      test: async (data) => { await build(data).fetchBalance() },
    },
  ],
})

export default asterPlugin
