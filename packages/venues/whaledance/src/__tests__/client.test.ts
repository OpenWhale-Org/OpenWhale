import { describe, expect, it, vi } from 'vitest'
import { TerminalAdapterError } from '@openwhaleorg/core'
import { WhaleDanceWalletClient } from '../client.js'

const identity = {
  id: 'hyperliquid-trading',
  venue: 'hyperliquid',
  address: '0x1234',
  scopes: ['wallet:read', 'orders:write', 'orders:cancel', 'positions:close', 'positions:manage'],
  policy: {
    allowedAssets: ['BTC', 'ETH'],
    maxLeverage: 5,
    maxOrderNotionalUsd: 1000,
    maxDailyNotionalUsd: 5000,
    maxSlippageBps: 100,
  },
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function client(fetchImpl: typeof fetch): WhaleDanceWalletClient {
  return new WhaleDanceWalletClient({
    apiBaseUrl: 'https://wallet.example.test/',
    walletCredential: 'wdc_123_secret',
    fetch: fetchImpl,
  })
}

describe('WhaleDanceWalletClient', () => {
  it('loads identity once and sends the Wallet Credential only as a bearer token', async () => {
    const fetchImpl = vi.fn(async () => json(identity)) as unknown as typeof fetch
    const wallet = client(fetchImpl)

    await Promise.all([wallet.getIdentity(), wallet.getIdentity()])

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!
    expect(url).toBe('https://wallet.example.test/external/v1/wallet/account')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer wdc_123_secret' })
  })

  it('retries a lost response with exactly the same idempotency key', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(identity))
      .mockRejectedValueOnce(new Error('socket closed'))
      .mockResolvedValueOnce(json({ executionId: 'exec-1', status: 'succeeded', replayed: true, result: { ok: true } })) as unknown as typeof fetch
    const wallet = client(fetchImpl)

    const result = await wallet.execute({ action: 'openMarket', coin: 'BTC', isBuy: true, marginUsd: 100, leverage: 3 }, 'message-1')

    expect(result).toMatchObject({ executionId: 'exec-1', status: 'succeeded', replayed: true })
    const firstWrite = vi.mocked(fetchImpl).mock.calls[1]![1]?.headers as Record<string, string>
    const secondWrite = vi.mocked(fetchImpl).mock.calls[2]![1]?.headers as Record<string, string>
    expect(firstWrite['Idempotency-Key']).toMatch(/^ow_[0-9a-f]{64}$/)
    expect(secondWrite['Idempotency-Key']).toBe(firstWrite['Idempotency-Key'])
  })

  it('preserves a 503 execution id as an unknown outcome and does not create a new command', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({
        error: 'execution_record_unavailable',
        executionId: 'exec-uncertain',
        message: 'Command was submitted; check execution status before retrying',
      }, 503)) as unknown as typeof fetch
    const wallet = client(fetchImpl)

    const result = await wallet.execute({ action: 'closePosition', coin: 'BTC', size: 0.01 }, 'message-2')

    expect(result).toMatchObject({ executionId: 'exec-uncertain', status: 'unknown' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('recovers a 409 by querying the original execution', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json(identity))
      .mockResolvedValueOnce(json({ error: 'execution_unknown', executionId: 'exec-2', message: 'cannot replay' }, 409))
      .mockResolvedValueOnce(json({ id: 'exec-2', action: 'market_open', asset: 'BTC', status: 'pending' })) as unknown as typeof fetch
    const wallet = client(fetchImpl)

    const result = await wallet.execute({ action: 'openMarket', coin: 'BTC', isBuy: true, marginUsd: 100, leverage: 3 }, 'message-3')

    expect(result).toMatchObject({ executionId: 'exec-2', status: 'pending' })
    expect(vi.mocked(fetchImpl).mock.calls[2]![0]).toBe('https://wallet.example.test/external/v1/wallet/executions/exec-2')
  })

  it('rejects policy violations before sending a write request', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(json(identity)) as unknown as typeof fetch
    const wallet = client(fetchImpl)

    await expect(wallet.execute(
      { action: 'openMarket', coin: 'BTC', isBuy: true, marginUsd: 500, leverage: 5 },
      'message-4',
    )).rejects.toBeInstanceOf(TerminalAdapterError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
