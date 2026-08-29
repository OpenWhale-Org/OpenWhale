import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { BaseExecutor } from '../BaseExecutor.js'
import { MemoryExecutionQueue } from '../MemoryExecutionQueue.js'
import type { ExecutionInstruction, ExecutionResult } from '../../types/executor.js'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-claim-'))

/**
 * PnL auto-claim attributes each discovered `{ orderId, symbol }` to an
 * account. A multi-slot executor placing one leg per account names the
 * account on the order object; anything else falls back to the first one.
 */

type Claim = { instanceId: string; account: string; symbol: string; orderId: string }

class EchoExecutor extends BaseExecutor {
  constructor(private readonly data: Record<string, unknown>) { super({ dataDir: tmpDir }) }
  get executorName() { return 'echo' }
  get supportedActions() { return ['noop'] }
  async execute(instruction: ExecutionInstruction): Promise<ExecutionResult> {
    return { instruction, status: 'success', executedAt: new Date(), data: this.data }
  }
}

async function claimsFor(data: Record<string, unknown>, accountNames: string[] | undefined): Promise<Claim[]> {
  const executor = new EchoExecutor(data)
  const claims: Claim[] = []
  executor.setClaimSink(c => claims.push({ instanceId: c.instanceId, account: c.account, symbol: c.symbol, orderId: c.orderId }))
  const queue = new MemoryExecutionQueue()
  const consuming = executor.run(queue, 'echo')
  await queue.push({
    messageId: 'm1', executorId: 'echo', action: 'noop', params: {},
    instanceId: 'inst-1', ...(accountNames ? { accountNames } : {}),
  } as ExecutionInstruction)
  const deadline = Date.now() + 3_000
  while (claims.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10))
  await new Promise(r => setTimeout(r, 30))   // let a second claim land too
  await queue.stop()
  await consuming
  return claims
}

describe('autoClaimOrders account attribution', () => {
  it('defaults every order to the first account', async () => {
    const claims = await claimsFor({ legs: [{ orderId: 1, symbol: 'A/USDT:USDT' }, { orderId: '2', symbol: 'B/USDT:USDT' }] }, ['acct-a', 'acct-b'])
    expect(claims.map(c => c.account)).toEqual(['acct-a', 'acct-a'])
  })

  it('honours accountName on the order object', async () => {
    const claims = await claimsFor({
      long: { orderId: 'L1', symbol: 'A/USDT:USDT', accountName: 'acct-a' },
      short: { orderId: 'S1', symbol: 'A/USDT:USDT', accountName: 'acct-b' },
    }, ['acct-a', 'acct-b'])
    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ orderId: 'L1', account: 'acct-a' }),
      expect.objectContaining({ orderId: 'S1', account: 'acct-b' }),
    ]))
    expect(claims).toHaveLength(2)
  })

  it('resolves accountIndex against the instruction accounts', async () => {
    const claims = await claimsFor({ orders: [
      { orderId: 'L1', symbol: 'A/USDT:USDT', accountIndex: 0 },
      { orderId: 'S1', symbol: 'B/USDT:USDT', accountIndex: 1 },
    ] }, ['acct-a', 'acct-b'])
    expect(claims.map(c => [c.orderId, c.account])).toEqual([['L1', 'acct-a'], ['S1', 'acct-b']])
  })

  it('accountName wins over accountIndex; an out-of-range index falls back', async () => {
    const claims = await claimsFor({ orders: [
      { orderId: 'X', symbol: 'A/USDT:USDT', accountName: 'acct-c', accountIndex: 1 },
      { orderId: 'Y', symbol: 'A/USDT:USDT', accountIndex: 7 },
    ] }, ['acct-a', 'acct-b'])
    expect(claims.map(c => [c.orderId, c.account])).toEqual([['X', 'acct-c'], ['Y', 'acct-a']])
  })

  it('still claims a self-named order when the instruction names no account', async () => {
    const claims = await claimsFor({ orderId: 'Z', symbol: 'A/USDT:USDT', accountName: 'acct-b' }, undefined)
    expect(claims).toEqual([{ instanceId: 'inst-1', account: 'acct-b', symbol: 'A/USDT:USDT', orderId: 'Z' }])
  })
})
