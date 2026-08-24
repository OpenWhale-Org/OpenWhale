/**
 * The 'web3/chain' kind — raw chain access as infrastructure.
 *
 * Scope rule (decided 2026-08-24): this contract only carries operations a
 * SINGLE RPC ENDPOINT can complete — balances, contract reads, signing,
 * sending, receipts. Anything needing an external service (quote APIs,
 * indexers, bridges, relayers) belongs to another kind.
 *
 * Keyless sessions (no credential) are read-only over public RPCs; binding a
 * 'web3/evm' credential adds signing and sending. The chain is a CALL
 * parameter, never part of the credential: one EVM key works on every EVM
 * chain.
 */

export interface ChainTokenBalance {
  chainId: number
  /** Token symbol ('ETH', 'USDC'). */
  symbol: string
  /** ERC-20 contract address, or 'native' for the chain's gas currency. */
  token: string
  /** Balance in decimal units. */
  amount: number
  /** Balance in integer base units. */
  raw: string
  decimals: number
  /** 1:1 USD value for known stables; absent otherwise (this kind has no price feed). */
  usdValue?: number
}

export interface EvmTransactionRequest {
  chainId: number
  to: `0x${string}`
  data?: `0x${string}`
  value?: bigint
  gas?: bigint
}

export interface EvmReceipt {
  status: 'success' | 'reverted'
  blockNumber: bigint
  transactionHash: `0x${string}`
  gasUsed: bigint
}

export interface EvmReadContractArgs {
  chainId: number
  address: `0x${string}`
  abi: readonly unknown[]
  functionName: string
  args?: readonly unknown[]
}

/** EIP-712 payload for signTypedData — the shape viem accepts. */
export interface EvmTypedData {
  domain: Record<string, unknown>
  types: Record<string, readonly { name: string; type: string }[]>
  primaryType: string
  message: Record<string, unknown>
}

export interface EvmChainSession {
  /** The wallet address; undefined on keyless (public RPC read-only) sessions. */
  readonly address?: `0x${string}`

  // ── Reads (keyless-capable) ────────────────────────────────────────────────

  nativeBalance(chainId: number, address?: `0x${string}`): Promise<ChainTokenBalance>
  erc20Balance(chainId: number, token: `0x${string}`, address?: `0x${string}`): Promise<ChainTokenBalance>
  /** Balances over the built-in stablecoin registry for one chain; zero balances omitted. */
  stablecoinBalances(chainId: number, address?: `0x${string}`): Promise<ChainTokenBalance[]>
  readContract(args: EvmReadContractArgs): Promise<unknown>
  waitForReceipt(chainId: number, hash: `0x${string}`): Promise<EvmReceipt>

  // ── Writes (credentialed sessions only — throw on keyless) ─────────────────

  /**
   * Sign and send, serialized per chain: one session is shared by every
   * consumer of the credential, and this queue is what keeps their nonces
   * from racing. The single place a private key materializes into signatures.
   */
  sendTransaction(tx: EvmTransactionRequest): Promise<`0x${string}`>
  signMessage(message: string): Promise<`0x${string}`>
  signTypedData(typedData: EvmTypedData): Promise<`0x${string}`>

  close(): Promise<void>
}
