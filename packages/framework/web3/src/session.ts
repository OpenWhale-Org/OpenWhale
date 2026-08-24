import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http } from 'viem'
import type { Chain, PublicClient, WalletClient, Account, Transport } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { ChainTokenBalance, EvmChainSession, EvmReadContractArgs, EvmReceipt, EvmTransactionRequest, EvmTypedData } from './types.js'
import { STABLECOINS, chainById } from './chains.js'

export interface EvmSessionOptions {
  /** Absent = keyless (public RPC read-only). */
  privateKey?: string
  /**
   * User RPC overrides, loaded lazily (they live in the 'web3/rpc' credential
   * entry, which may change after this session is built). Cached on first use.
   */
  loadRpcOverrides?: () => Promise<Record<number, string>>
}

function normalizeKey(key: string): `0x${string}` {
  return (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`
}

/**
 * The (web3/chain, evm) cell's session. One instance is shared by every
 * consumer of a credential (the resolver caches it), which is what makes the
 * per-chain send queue a real nonce serializer rather than a suggestion.
 */
export class EvmChainSessionImpl implements EvmChainSession {
  readonly address?: `0x${string}`
  private readonly account?: Account
  private readonly loadRpcOverrides?: () => Promise<Record<number, string>>
  private rpcOverrides?: Record<number, string>
  private readonly publicClients = new Map<number, PublicClient>()
  private readonly walletClients = new Map<number, WalletClient<Transport, Chain, Account>>()
  private readonly decimalsCache = new Map<string, number>()
  /** Per-chain send tail — sendTransaction chains onto it so nonces never race. */
  private readonly sendTail = new Map<number, Promise<unknown>>()

  constructor(options: EvmSessionOptions = {}) {
    if (options.privateKey !== undefined && options.privateKey.length > 0) {
      this.account = privateKeyToAccount(normalizeKey(options.privateKey))
      this.address = this.account.address
    }
    if (options.loadRpcOverrides) this.loadRpcOverrides = options.loadRpcOverrides
  }

  private async rpcUrl(chainId: number): Promise<string | undefined> {
    if (this.rpcOverrides === undefined && this.loadRpcOverrides) {
      try {
        this.rpcOverrides = await this.loadRpcOverrides()
      } catch {
        this.rpcOverrides = {}
      }
    }
    return this.rpcOverrides?.[chainId]
  }

  private async publicClient(chainId: number): Promise<PublicClient> {
    const cached = this.publicClients.get(chainId)
    if (cached) return cached
    const chain = chainById(chainId)
    const url = await this.rpcUrl(chainId)
    const client = createPublicClient({ chain, transport: http(url) })
    this.publicClients.set(chainId, client)
    return client
  }

  private async walletClient(chainId: number): Promise<WalletClient<Transport, Chain, Account>> {
    if (!this.account) throw new Error('This web3 session is keyless (read-only) — bind a web3/evm credential to sign')
    const cached = this.walletClients.get(chainId)
    if (cached) return cached
    const chain = chainById(chainId)
    const url = await this.rpcUrl(chainId)
    const client = createWalletClient({ account: this.account, chain, transport: http(url) })
    this.walletClients.set(chainId, client)
    return client
  }

  private subjectAddress(explicit?: `0x${string}`): `0x${string}` {
    const address = explicit ?? this.address
    if (!address) throw new Error('Keyless session: pass the address to read explicitly')
    return address
  }

  async nativeBalance(chainId: number, address?: `0x${string}`): Promise<ChainTokenBalance> {
    const subject = this.subjectAddress(address)
    const client = await this.publicClient(chainId)
    const raw = await client.getBalance({ address: subject })
    const chain = chainById(chainId)
    const decimals = chain.nativeCurrency.decimals
    return {
      chainId,
      symbol: chain.nativeCurrency.symbol,
      token: 'native',
      amount: Number(formatUnits(raw, decimals)),
      raw: raw.toString(),
      decimals,
    }
  }

  private async tokenDecimals(chainId: number, token: `0x${string}`): Promise<number> {
    const key = `${chainId}:${token.toLowerCase()}`
    const cached = this.decimalsCache.get(key)
    if (cached !== undefined) return cached
    const client = await this.publicClient(chainId)
    const decimals = await client.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' })
    this.decimalsCache.set(key, Number(decimals))
    return Number(decimals)
  }

  async erc20Balance(chainId: number, token: `0x${string}`, address?: `0x${string}`): Promise<ChainTokenBalance> {
    const subject = this.subjectAddress(address)
    const client = await this.publicClient(chainId)
    const [raw, decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [subject] }),
      this.tokenDecimals(chainId, token),
      client.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }).catch(() => token.slice(0, 8)),
    ])
    return {
      chainId,
      symbol: String(symbol),
      token,
      amount: Number(formatUnits(raw, decimals)),
      raw: raw.toString(),
      decimals,
    }
  }

  async stablecoinBalances(chainId: number, address?: `0x${string}`): Promise<ChainTokenBalance[]> {
    const subject = this.subjectAddress(address)
    const entries = STABLECOINS[chainId] ?? []
    const balances = await Promise.all(entries.map(async ({ symbol, address: token }) => {
      const balance = await this.erc20Balance(chainId, token, subject)
      // The registry's symbol wins — venues rename bridged variants on-chain
      return { ...balance, symbol, usdValue: balance.amount }
    }))
    return balances.filter(b => b.amount > 0)
  }

  async readContract(args: EvmReadContractArgs): Promise<unknown> {
    const client = await this.publicClient(args.chainId)
    return client.readContract({
      address: args.address,
      abi: args.abi as never,
      functionName: args.functionName as never,
      ...(args.args !== undefined ? { args: args.args as never } : {}),
    })
  }

  async waitForReceipt(chainId: number, hash: `0x${string}`): Promise<EvmReceipt> {
    const client = await this.publicClient(chainId)
    const receipt = await client.waitForTransactionReceipt({ hash })
    return {
      status: receipt.status === 'success' ? 'success' : 'reverted',
      blockNumber: receipt.blockNumber,
      transactionHash: receipt.transactionHash,
      gasUsed: receipt.gasUsed,
    }
  }

  sendTransaction(tx: EvmTransactionRequest): Promise<`0x${string}`> {
    const prev = this.sendTail.get(tx.chainId) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(async () => {
      const wallet = await this.walletClient(tx.chainId)
      const client = await this.publicClient(tx.chainId)
      const nonce = await client.getTransactionCount({ address: this.address!, blockTag: 'pending' })
      return wallet.sendTransaction({
        to: tx.to,
        nonce,
        ...(tx.data !== undefined ? { data: tx.data } : {}),
        ...(tx.value !== undefined ? { value: tx.value } : {}),
        ...(tx.gas !== undefined ? { gas: tx.gas } : {}),
      })
    })
    this.sendTail.set(tx.chainId, next)
    return next
  }

  async signMessage(message: string): Promise<`0x${string}`> {
    if (!this.account?.signMessage) throw new Error('This web3 session is keyless (read-only) — bind a web3/evm credential to sign')
    return this.account.signMessage({ message })
  }

  async signTypedData(typedData: EvmTypedData): Promise<`0x${string}`> {
    if (!this.account?.signTypedData) throw new Error('This web3 session is keyless (read-only) — bind a web3/evm credential to sign')
    return this.account.signTypedData(typedData as never)
  }

  async close(): Promise<void> {
    // http transports hold no persistent connections
  }
}
