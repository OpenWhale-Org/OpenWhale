import { describe, it, expect } from 'vitest'
import { parseRpcEndpoints, chainById, STABLECOINS } from '../chains.js'
import { EvmChainSessionImpl } from '../session.js'
import { ChainAccount } from '../ChainAccount.js'
import type { EvmChainSession } from '../types.js'
import { web3Plugin } from '../plugin.js'
import type { CredentialStore } from '@openwhaleorg/core'

describe('rpc endpoint parsing', () => {
  it('parses a chain-id → url map', () => {
    expect(parseRpcEndpoints('{"42161": "https://rpc.example/KEY", "8453": "http://localhost:8545"}'))
      .toEqual({ 42161: 'https://rpc.example/KEY', 8453: 'http://localhost:8545' })
  })
  it('empty/absent input means no overrides', () => {
    expect(parseRpcEndpoints('')).toEqual({})
    expect(parseRpcEndpoints(undefined)).toEqual({})
  })
  it('rejects non-numeric keys and non-url values', () => {
    expect(() => parseRpcEndpoints('{"arbitrum": "https://x"}')).toThrow(/chain ids/)
    expect(() => parseRpcEndpoints('{"1": "not-a-url"}')).toThrow(/URLs/)
  })
})

describe('chain registry', () => {
  it('resolves well-known chains from viem', () => {
    expect(chainById(42161).name.toLowerCase()).toContain('arbitrum')
    expect(chainById(1).nativeCurrency.symbol).toBe('ETH')
    expect(() => chainById(123456780)).toThrow(/Unknown EVM chain/)
  })
  it('carries stablecoin entries for the major chains', () => {
    for (const id of [1, 10, 56, 137, 8453, 42161]) expect(STABLECOINS[id]!.length).toBeGreaterThan(0)
  })
})

describe('session key handling', () => {
  it('keyless sessions have no address and refuse to sign', async () => {
    const session = new EvmChainSessionImpl()
    expect(session.address).toBeUndefined()
    await expect(session.signMessage('hi')).rejects.toThrow(/keyless/)
    await expect(session.sendTransaction({ chainId: 1, to: '0x0000000000000000000000000000000000000001' }))
      .rejects.toThrow(/keyless/)
  })
  it('derives the address from a private key, 0x-prefixed or not', () => {
    const bare = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
    const a = new EvmChainSessionImpl({ privateKey: bare })
    const b = new EvmChainSessionImpl({ privateKey: `0x${bare}` })
    expect(a.address).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')
    expect(b.address).toBe(a.address)
  })
})

describe('ChainAccount params', () => {
  const fake = { address: '0xabc' } as unknown as EvmChainSession
  it('parses the comma-separated chain list', () => {
    const account = new ChainAccount('W', fake, { chains: '1, 42161,8453' })
    expect(account.chainIds()).toEqual([1, 42161, 8453])
  })
  it('defaults to Arbitrum when params are absent or garbage', () => {
    expect(new ChainAccount('W', fake).chainIds()).toEqual([42161])
    expect(new ChainAccount('W', fake, { chains: 'x,y' }).chainIds()).toEqual([42161])
  })
})

describe('plugin manifest', () => {
  it('registers the namespaced credential types and the (web3/chain, evm) cell', () => {
    const store = { list: async () => [], getByName: async () => ({ type: 'x', data: {} }) } as unknown as CredentialStore
    const plugin = web3Plugin({ credentials: store, config: {} })
    expect(plugin.credentialTypes!.map(t => t.type).sort()).toEqual(['web3/evm', 'web3/rpc'])
    const cell = plugin.adapters![0]!
    expect(cell.kind).toBe('web3/chain')
    expect(cell.venue).toBe('evm')
    expect(cell.credentialTypes).toEqual(['web3/evm'])
    const keyless = cell.create() as EvmChainSession
    expect(keyless.address).toBeUndefined()
  })
})
