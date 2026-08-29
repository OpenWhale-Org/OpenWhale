import { privateKeyToAccount } from 'viem/accounts'
import { CcxtAdapter } from '@openwhaleorg/ccxt-adapter'
import { TerminalAdapterError } from '@openwhaleorg/core'

export interface AsterCredentials {
  /** Master account wallet address — Aster's `user`. Identity and funds; its key is never held here. */
  walletAddress: string
  /** The API WALLET's private key — Aster's signer. Created at asterdex.com/en/api-wallet (Pro API). */
  privateKey: string
  /**
   * The API wallet's own address — Aster's `signer`. Derived from the private
   * key when omitted, which is the normal case: a mistyped signer is rejected
   * by the venue as a bad signature, with nothing on the request that says so.
   */
  signerAddress?: string
  /** Aster has no public testnet — passing true fails loudly instead of silently trading mainnet. */
  testnet?: boolean
}

const HEX_KEY = /^(0x)?[0-9a-fA-F]{64}$/

/**
 * Aster perpetual DEX adapter (asterdex.com).
 *
 * Authentication is an API WALLET, not an API key. Every private v3 request is
 * EIP-712 typed data (`AsterSignTransaction`, chainId 1666) carrying
 * `user` = the master wallet address, `signer` = the API wallet address, and a
 * signature made with the API wallet's private key. ccxt 4.5.52 removed the
 * HMAC path entirely — `requiredCredentials` is `privateKey` alone, and
 * passing an apiKey/secret pair now raises NotSupported.
 *
 * The master wallet's own key is never needed and must never be pasted here:
 * an API wallet is a delegated signer, so a leaked one cannot move the funds
 * the master account holds.
 */
export class AsterAdapter extends CcxtAdapter {
  constructor(credentials: AsterCredentials) {
    if (credentials.testnet) {
      throw new TerminalAdapterError(
        'Aster has no testnet/sandbox — remove the testnet flag from this credential. ' +
        'All Aster orders are live.'
      )
    }
    const { walletAddress, privateKey } = credentials
    if (!walletAddress || !privateKey) {
      throw new TerminalAdapterError(
        'Aster now authenticates with an API wallet: this credential needs the master wallet address ' +
        'and the API wallet private key. An older API key / secret credential cannot sign v3 requests — ' +
        'create a new one at asterdex.com/en/api-wallet (Pro API).'
      )
    }
    if (!HEX_KEY.test(privateKey)) {
      throw new TerminalAdapterError(
        'Aster private key must be the API wallet key: 64 hex characters, with or without the 0x prefix.'
      )
    }
    const key = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`
    // Derived, not asked for: the signer address IS the key's address, and
    // ccxt refuses to sign without it (`requires signerAddress in options`).
    const signerAddress = credentials.signerAddress?.trim() || privateKeyToAccount(key).address
    super({
      exchangeId: 'aster',
      walletAddress,
      privateKey: key,
      ccxtOptions: { options: { signerAddress } },
    })
  }
}
