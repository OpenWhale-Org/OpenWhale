import { z } from 'zod'
import { definePlugin } from '@openwhaleorg/core'
import type { RawCredentialData } from '@openwhaleorg/core'
import { WhaleDanceWalletAccount } from './account.js'
import { WhaleDanceWalletClient } from './client.js'
import { WhaleDanceWalletExecutor } from './executor.js'

function build(data: RawCredentialData): WhaleDanceWalletClient {
  return new WhaleDanceWalletClient({
    apiBaseUrl: data['apiBaseUrl'] as string,
    walletCredential: data['walletCredential'] as string,
  })
}

export const whaledancePlugin = definePlugin({
  name: 'whaledance',
  version: '0.1.0',
  icon: '🐋',
  readme: [
    '# WhaleDance Wallet',
    '',
    'A policy-scoped delegated Hyperliquid wallet. Wallet reads and trading commands go through WhaleDance; the credential never reaches strategies.',
    '',
    'Create and scope the Wallet Credential in WhaleDance, then paste the one-time `wdc_…` value into OpenWhale. Rotate or revoke it in WhaleDance.',
  ].join('\n'),
  credentialTypes: [{
    type: 'whaledance/wallet',
    displayName: 'WhaleDance Wallet',
    category: 'WhaleDance',
    icon: '🐋',
    description: 'Delegated Hyperliquid wallet access with WhaleDance scopes and risk limits.',
    schema: z.object({
      apiBaseUrl: z.url().refine((value) => {
        const url = new URL(value)
        const secure = url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))
        return secure && url.pathname === '/' && !url.search && !url.hash
      }, 'Use an HTTPS origin without a path (HTTP is allowed only for localhost)').meta({
        displayName: 'API Base URL',
        placeholder: 'https://api.example.com',
        description: 'WhaleDance API origin, without /external/v1/wallet',
      }),
      walletCredential: z.string().startsWith('wdc_').meta({
        displayName: 'Wallet Credential',
        placeholder: 'wdc_…',
        password: true,
        description: 'The one-time credential shown by WhaleDance. It is encrypted at rest.',
      }),
    }),
    test: async (data) => { await build(data).getIdentity() },
  }],
  adapters: [{
    kind: 'whaledance/wallet',
    venue: 'whaledance/wallet',
    credentialTypes: ['whaledance/wallet'],
    create: (data) => {
      if (!data) throw new Error('WhaleDance wallet sessions require a credential')
      return build(data)
    },
  }],
  accounts: [WhaleDanceWalletAccount],
  executors: [WhaleDanceWalletExecutor],
})

export default whaledancePlugin
