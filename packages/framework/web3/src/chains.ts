import * as viemChains from 'viem/chains'
import type { Chain } from 'viem'

/**
 * Chain lookup over viem's registry — public default RPCs come from here, so
 * a fresh install reads balances with zero configuration. User overrides
 * (paid endpoints) come from the 'web3/rpc' credential entry.
 */
const byId = new Map<number, Chain>()
for (const candidate of Object.values(viemChains)) {
  const chain = candidate as Chain
  if (typeof chain === 'object' && chain !== null && typeof chain.id === 'number' && chain.rpcUrls !== undefined) {
    if (!byId.has(chain.id)) byId.set(chain.id, chain)
  }
}

export function chainById(chainId: number): Chain {
  const chain = byId.get(chainId)
  if (!chain) throw new Error(`Unknown EVM chain id ${chainId} — not in viem's registry`)
  return chain
}

/**
 * Well-known stablecoin contracts per chain — the priceable subset of a
 * wallet, mirroring SpotAccount's convention (stables at 1:1 USD, everything
 * else listed but unvalued). Decimals are fetched on-chain, never assumed.
 */
export const STABLECOINS: Record<number, { symbol: string; address: `0x${string}` }[]> = {
  1: [
    { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
    { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
    { symbol: 'DAI', address: '0x6B175474E89094C44Da98b954EedeAC495271d0F' },
  ],
  10: [
    { symbol: 'USDC', address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85' },
    { symbol: 'USDC.e', address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607' },
    { symbol: 'USDT', address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58' },
    { symbol: 'DAI', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1' },
  ],
  56: [
    { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955' },
    { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d' },
  ],
  137: [
    { symbol: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
    { symbol: 'USDC.e', address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' },
    { symbol: 'USDT', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
    { symbol: 'DAI', address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063' },
  ],
  8453: [
    { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
    { symbol: 'USDbC', address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' },
    { symbol: 'DAI', address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' },
  ],
  42161: [
    { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' },
    { symbol: 'USDC.e', address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8' },
    { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9' },
    { symbol: 'DAI', address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1' },
  ],
}

/** Parse the 'web3/rpc' credential's endpoints field: a JSON chainId→URL map. */
export function parseRpcEndpoints(raw: unknown): Record<number, string> {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const out: Record<number, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const id = Number(key)
    if (!Number.isInteger(id) || typeof value !== 'string' || !/^https?:\/\//.test(value)) {
      throw new Error(`Invalid RPC entry "${key}": keys are chain ids, values are http(s) URLs`)
    }
    out[id] = value
  }
  return out
}
