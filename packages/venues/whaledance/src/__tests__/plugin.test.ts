import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenWhaleRuntime } from '@openwhaleorg/core'
import type { CredentialStore } from '@openwhaleorg/core'
import { whaledancePlugin } from '../plugin.js'

const credentialStore: CredentialStore = {
  set: async (name, type) => ({ id: 'credential-1', name, type, createdAt: '', updatedAt: '' }),
  getByName: async () => ({
    type: 'whaledance/wallet',
    data: { apiBaseUrl: 'https://wallet.example.test', walletCredential: 'wdc_123_secret' },
  }),
  delete: async () => {},
  list: async () => [{ id: 'credential-1', name: 'WhaleDance Key', type: 'whaledance/wallet', createdAt: '', updatedAt: '' }],
}

function responseFor(url: string): Response {
  if (url.endsWith('/account')) return Response.json({
    id: 'hyperliquid-trading', venue: 'hyperliquid', address: '0x1234', scopes: ['wallet:read'],
    policy: { allowedAssets: [], maxLeverage: 5, maxOrderNotionalUsd: 1000, maxDailyNotionalUsd: 5000, maxSlippageBps: 100 },
  })
  if (url.endsWith('/balance')) return Response.json({
    accountValue: '123.45', withdrawable: '100.00', totalMarginUsed: '23.45', spotUsdc: '123.45', loading: false,
  })
  if (url.endsWith('/positions')) return Response.json({ assetPositions: [], loading: false })
  if (url.endsWith('/orders')) return Response.json([])
  return Response.json({ message: 'not found' }, { status: 404 })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('whaledancePlugin', () => {
  it('registers a first-class credential, account, session kind and executor', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => responseFor(String(input))))
    const runtime = new OpenWhaleRuntime({ credentialStore })
    runtime.loadPlugin(whaledancePlugin, {})

    expect(runtime.describeCredentialTypes()).toContainEqual(expect.objectContaining({
      type: 'whaledance/wallet',
      kinds: ['whaledance/wallet'],
    }))
    expect(runtime.listAccountImplementations()).toContainEqual(expect.objectContaining({
      id: 'whaledance/wallet-account',
      kind: 'whaledance/wallet',
      venue: 'whaledance/wallet',
    }))
    expect(runtime.listExecutors()).toContainEqual(expect.objectContaining({
      id: 'whaledance/wallet-executor',
    }))

    await runtime.saveAccount({
      name: 'WhaleDance Main',
      implementation: 'whaledance/wallet-account',
      credential: 'WhaleDance Key',
    })
    const detail = await runtime.accountDetail('WhaleDance Main')
    expect(detail.sections['identity']).toMatchObject({ marketVenue: 'hyperliquid', address: '0x1234' })
    expect(detail.sections['balance']).toMatchObject({ accountValue: '123.45', withdrawable: '100.00' })
    expect(detail.sections['positions']).toEqual([])
    expect(detail.sections['orders']).toEqual([])

    await runtime.stop()
  })
})
