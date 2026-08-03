import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import { TerminalAdapterError } from '@openwhaleorg/core'

export interface AsterCredentials {
  apiKey: string
  secret: string
  /** Aster has no public testnet — passing true fails loudly instead of silently trading mainnet. */
  testnet?: boolean
}

/**
 * Aster perpetual DEX adapter (asterdex.com, Binance-futures-compatible API).
 *
 * Pure CcxtAdapter configuration over ccxt's 'aster' exchange.
 */
export class AsterAdapter extends CcxtAdapter {
  constructor(credentials: AsterCredentials) {
    if (credentials.testnet) {
      throw new TerminalAdapterError(
        'Aster has no testnet/sandbox — remove the testnet flag from this credential. ' +
        'All Aster orders are live.'
      )
    }
    super({
      exchangeId: 'aster',
      apiKey: credentials.apiKey,
      secret: credentials.secret,
    })
  }
}
