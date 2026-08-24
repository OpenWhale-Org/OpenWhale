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
