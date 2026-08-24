export type {
  ChainTokenBalance,
  EvmChainSession,
  EvmReadContractArgs,
  EvmReceipt,
  EvmTransactionRequest,
  EvmTypedData,
} from './types.js'
export { EvmChainSessionImpl } from './session.js'
export type { EvmSessionOptions } from './session.js'
export { ChainAccount } from './ChainAccount.js'
export { evmCredentialType, evmRpcCredentialType } from './credentialTypes.js'
export { STABLECOINS, chainById, parseRpcEndpoints } from './chains.js'
export { web3Plugin } from './plugin.js'

// Kind contract — merged into core's kind table
import type { EvmChainSession } from './types.js'
import type { ChainAccount as ChainAccountClass } from './ChainAccount.js'
declare module '@openwhaleorg/core' {
  interface AdapterKindMap {
    'web3/chain': { session: EvmChainSession; reader: ChainAccountClass }
  }
}

// Plugin-package convention: the entry default-exports the plugin factory
// so runtime.loadPluginFromPath (dashboard install) can load it.
export { default } from './plugin.js'
