import { z } from 'zod'
import { OwAccount } from '@openwhaleorg/core'
import { ETH_LOGO } from './brand.js'
import type { ChainTokenBalance, EvmChainSession } from './types.js'

const paramsSchema = z.object({
  chains: z.string().default('42161').meta({
    displayName: 'Chain ids',
    placeholder: '1,42161,8453',
    description: 'Comma-separated EVM chain ids this account aggregates',
  }),
})

/**
 * Read-only view of an EVM wallet — the 'web3/chain' kind's canonical Reader
 * and the Accounts board's window into on-chain funds. One wallet = ONE
 * account: the chain is a parameter, so the view aggregates the configured
 * chain list (Account.params) instead of splitting per chain.
 *
 * Valuation follows SpotAccount's convention: known stables at 1:1 USD,
 * everything else (the native token included) listed but unvalued — this kind
 * has no price feed, and inventing valuations would be worse than omitting
 * them. snapshot() equity is therefore the stablecoin aggregate.
 */
@OwAccount({ id: 'chain-account', kind: 'web3/chain', venue: 'evm', displayName: 'EVM Wallet', paramsSchema, logo: ETH_LOGO })
export class ChainAccount {
  static readonly kind = 'web3/chain' as const
  static readonly venueType = 'evm'

  private readonly chains: number[]

  constructor(
    readonly name: string,
    protected readonly session: EvmChainSession,
    params?: Record<string, unknown>,
  ) {
    const raw = typeof params?.['chains'] === 'string' ? params['chains'] : '42161'
    this.chains = raw.split(',').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0)
    if (this.chains.length === 0) this.chains = [42161]
  }

  /** The wallet address behind this account (absent on keyless sessions). */
  address(): string | undefined {
    return this.session.address
  }

  chainIds(): number[] {
    return [...this.chains]
  }

  async balance(): Promise<{ usd: { available: number; total: number }; tokens: Array<{ token: string; free: number; locked: number; total: number; usdValue?: number }> }> {
    const perChain = await Promise.all(this.chains.map(async (chainId) => {
      const [native, stables] = await Promise.all([
        this.session.nativeBalance(chainId).catch(() => undefined),
        this.session.stablecoinBalances(chainId).catch(() => [] as ChainTokenBalance[]),
      ])
      return [...(native && native.amount > 0 ? [native] : []), ...stables]
    }))
    const tokens = perChain.flat().map(b => ({
      token: this.chains.length > 1 ? `${b.symbol}@${b.chainId}` : b.symbol,
      free: b.amount,
      locked: 0,
      total: b.amount,
      ...(b.usdValue !== undefined ? { usdValue: b.usdValue } : {}),
    }))
    const total = tokens.reduce((acc, t) => acc + (t.usdValue ?? 0), 0)
    return { usd: { available: total, total }, tokens }
  }

  /** Equity sample for the runtime snapshotter — the stablecoin aggregate. */
  async snapshot(): Promise<{ equity: number; available?: number }> {
    const balance = await this.balance()
    return { equity: balance.usd.total, available: balance.usd.available }
  }
}
