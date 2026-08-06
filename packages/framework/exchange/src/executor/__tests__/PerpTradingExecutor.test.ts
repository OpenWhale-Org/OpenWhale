import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ExchangeOrder, PerpOrderParams } from '../../types/exchange.js'
import { MockPerpAdapter } from '../../mock/MockPerpAdapter.js'
import { PerpTradingExecutor } from '../PerpTradingExecutor.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwhale-perp-executor-'))

class ContractSizedAdapter extends MockPerpAdapter {
  placedOrder?: PerpOrderParams

  override async baseAmountToContracts(_symbol: string, baseAmount: number): Promise<number> {
    return baseAmount / 10
  }

  override async amountToPrecision(_symbol: string, amount: number): Promise<number> {
    return Math.floor(amount)
  }

  override async createOrder(params: PerpOrderParams): Promise<ExchangeOrder> {
    this.placedOrder = params
    return super.createOrder(params)
  }
}

afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }))

describe('PerpTradingExecutor', () => {
  it('converts base units to venue contracts before applying amount precision', async () => {
    const adapter = new ContractSizedAdapter()
    const executor = new PerpTradingExecutor({ dataDir })
    executor.setMaterialized('instance-1', [{
      label: 'trading',
      credentialName: 'main',
      session: adapter,
    }])

    const result = await executor.fire({
      executorId: 'perp-trading',
      messageId: 'message-1',
      instanceId: 'instance-1',
      action: 'placeOrder',
      params: {
        symbol: 'BTC/USDT:USDT',
        side: 'buy',
        type: 'market',
        amount: 25,
      },
    })

    expect(result?.status).toBe('success')
    expect(adapter.placedOrder?.amount).toBe(2)
  })
})
