import { z } from 'zod'
import { ETH_LOGO } from './brand.js'
import { privateKeyToAccount } from 'viem/accounts'
import type { CredentialTypeDefinition, RawCredentialData } from '@openwhaleorg/core'
import { parseRpcEndpoints } from './chains.js'

/**
 * Web3 credential vocabulary — two entries with one iron rule between them:
 * the PRIVATE KEY exists in exactly one place. 'web3/evm' holds the key
 * (one entry per wallet); 'web3/rpc' holds the chain-id → endpoint map every
 * wallet shares (URLs embed provider API keys, so it lives in the encrypted
 * store too — the LLM credential precedent for non-key infrastructure
 * secrets). Namespaced ids are the convention for NEW credential types:
 * key families are defined only by their domain package, referenced —
 * never re-declared — by venue plugins.
 */

export const evmCredentialType: CredentialTypeDefinition = {
  type: 'web3/evm',
  displayName: 'EVM Wallet',
  category: 'Web3',
  logo: ETH_LOGO,
  icon: '⬡',
  description: 'One private key for every EVM chain — chain access and on-chain venues share it.',
  schema: z.object({
    privateKey: z.string().min(64).meta({ displayName: 'Private Key', password: true, placeholder: '0x…' }),
  }),
  raw: true,
  test: async (data: RawCredentialData) => {
    const key = String(data['privateKey'] ?? '')
    const normalized = (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`
    privateKeyToAccount(normalized) // throws on malformed keys; no network needed
  },
}

export const evmRpcCredentialType: CredentialTypeDefinition = {
  type: 'web3/rpc',
  displayName: 'EVM RPC Endpoints',
  category: 'Web3',
  icon: '⛓',
  description: 'Chain-id → RPC URL map shared by every wallet. Without it, public endpoints serve.',
  schema: z.object({
    endpoints: z.string().meta({
      displayName: 'Endpoints (JSON)',
      password: true,
      placeholder: '{"42161": "https://arb-mainnet.g.alchemy.com/v2/KEY"}',
      description: 'JSON object: chain id → RPC URL. URLs often embed provider keys — stored encrypted.',
    }),
  }),
  test: async (data: RawCredentialData) => {
    const endpoints = parseRpcEndpoints(data['endpoints'])
    if (Object.keys(endpoints).length === 0) throw new Error('No endpoints configured')
  },
}
