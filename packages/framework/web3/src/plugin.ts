import type { PluginFactory } from '@openwhaleorg/core'
import { evmCredentialType, evmRpcCredentialType } from './credentialTypes.js'
import { EvmChainSessionImpl } from './session.js'
import { ChainAccount } from './ChainAccount.js'
import { parseRpcEndpoints } from './chains.js'

/**
 * The web3 domain plugin. A raw factory (not definePlugin) because the
 * adapter cell needs the credential store: RPC overrides live in the shared
 * 'web3/rpc' credential entry, loaded lazily so a session picks up endpoints
 * that were configured after it was registered.
 *
 * One cell claims the kind: (web3/chain, evm) accepting 'web3/evm' keys —
 * keyless resolves to a public-RPC read-only session.
 */
export const web3Plugin: PluginFactory = (ctx) => {
  const loadRpcOverrides = async (): Promise<Record<number, string>> => {
    const infos = await ctx.credentials.list()
    const entry = infos.find(info => info.type === 'web3/rpc')
    if (!entry) return {}
    const { data } = await ctx.credentials.getByName(entry.name)
    return parseRpcEndpoints(data['endpoints'])
  }

  return {
    name: 'web3',
    version: '0.1.0',
    readme: [
      '# web3',
      '',
      'Chain access as infrastructure — the `web3/chain` kind carries only what a single RPC endpoint can do: balances, contract reads, signing, sending, receipts.',
      '',
      '## Credentials',
      '- **EVM Wallet** (`web3/evm`) — one private key for every EVM chain. The chain is a call parameter, and this is the ONLY copy of the key in the store.',
      '- **EVM RPC Endpoints** (`web3/rpc`) — a shared chain-id → URL map (provider keys embed in URLs, so it lives encrypted). Without it, viem\'s public endpoints serve; keyless sessions stay read-only.',
      '',
      '## Accounts',
      '**EVM Wallet** aggregates a configured chain list (`chains` param, comma-separated ids). Stables value 1:1 USD; nothing else is priced — this kind has no price feed.',
    ].join('\n'),
    monitors: [],
    executors: [],
    strategies: [],
    credentialTypes: [evmCredentialType, evmRpcCredentialType],
    adapters: [
      {
        kind: 'web3/chain',
        venue: 'evm',
        credentialTypes: ['web3/evm'],
        create: (data) => new EvmChainSessionImpl({
          ...(typeof data?.['privateKey'] === 'string' ? { privateKey: data['privateKey'] } : {}),
          loadRpcOverrides,
        }),
      },
    ],
    accounts: [ChainAccount],
  }
}

export default web3Plugin
