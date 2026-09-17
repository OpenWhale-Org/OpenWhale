import { describe, expect, it } from 'vitest'
import type { WhaleDanceWalletSession } from '../types.js'
import { WhaleDanceWalletExecutor } from '../executor.js'

class TestWalletExecutor extends WhaleDanceWalletExecutor {
  protected override async record(): Promise<void> {}
}

function session(outcome: Awaited<ReturnType<WhaleDanceWalletSession['execute']>>): WhaleDanceWalletSession {
  return {
    getIdentity: async () => ({
      id: 'wallet', venue: 'hyperliquid', address: '0x1', scopes: ['wallet:read'],
      policy: { allowedAssets: [], maxLeverage: 5, maxOrderNotionalUsd: 1000, maxDailyNotionalUsd: 5000, maxSlippageBps: 100 },
    }),
    getBalance: async () => ({ accountValue: '0', withdrawable: '0', totalMarginUsed: '0', spotUsdc: '0', loading: false }),
    getPositions: async () => [],
    getOrders: async () => [],
    execute: async () => outcome,
    getExecution: async (id) => ({ id, action: 'market_open', status: 'pending' }),
    close: async () => {},
  }
}

describe('WhaleDanceWalletExecutor', () => {
  it('records uncertain remote execution as unknown instead of failed', async () => {
    const executor = new TestWalletExecutor()
    executor.setMaterialized('instance-1', [{
      label: 'wallet',
      credentialName: 'wallet-credential',
      session: session({
        executionId: 'exec-unknown',
        status: 'unknown',
        idempotencyKey: 'ow_key',
        error: 'upstream timed out',
      }),
    }])

    const result = await executor.fire({
      executorId: 'whaledance/wallet-executor',
      messageId: 'message-1',
      instanceId: 'instance-1',
      action: 'openMarket',
      params: { coin: 'BTC', isBuy: true, marginUsd: 100, leverage: 3 },
    })

    expect(result).toMatchObject({
      status: 'unknown',
      error: 'upstream timed out',
      data: { executionId: 'exec-unknown', remoteStatus: 'unknown', idempotencyKey: 'ow_key' },
    })
  })
})
