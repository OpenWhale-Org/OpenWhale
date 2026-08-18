import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteAdapter } from '../../database/SQLiteAdapter.js'
import { PortfolioJournal } from '../PortfolioJournal.js'
import type { PortfolioSnapshot } from '../../types/portfolio.js'

let dir: string
let db: SQLiteAdapter
let journal: PortfolioJournal

function snapshot(timestamp: number, equityUsd: number, realizedPnlUsd = 0): PortfolioSnapshot {
  const netPnlUsd = equityUsd - 10_000
  return {
    mode: 'paper',
    timestamp,
    startingEquityUsd: 10_000,
    equityUsd,
    availableUsd: equityUsd,
    usedMarginUsd: 0,
    realizedPnlUsd,
    unrealizedPnlUsd: netPnlUsd - realizedPnlUsd,
    feesUsd: 0,
    netPnlUsd,
    returnPct: netPnlUsd / 100,
    positions: [],
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-portfolio-journal-'))
  db = new SQLiteAdapter({ filePath: path.join(dir, 'test.db') })
  await db.initialize()
  journal = new PortfolioJournal('instance-1', db)
})

afterEach(async () => {
  await db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('PortfolioJournal', () => {
  it('commits idempotently and reports equity, drawdown, fills, trades, decisions, and bars', async () => {
    await journal.commit({
      commitId: 'run-1',
      snapshot: snapshot(1_000, 10_000),
      fills: [{
        id: 'fill-open', planId: 'plan-1', timestamp: 1_000, symbol: 'BTC', side: 'buy',
        intent: 'open', quantity: 1, price: 100, notionalUsd: 100, feeUsd: 1, realizedPnlUsd: 0,
      }],
      decisions: [{ id: 'decision-1', timestamp: 1_000, symbol: 'BTC', action: 'OPEN_LONG', confidence: 80 }],
      marketBars: [{ symbol: 'BTC', timestamp: 1_000, open: 99, high: 102, low: 98, close: 100 }],
    })
    await journal.commit({
      commitId: 'run-2',
      snapshot: snapshot(2_000, 9_500),
    })
    await journal.commit({
      commitId: 'run-3',
      snapshot: snapshot(3_000, 10_200, 202),
      fills: [{
        id: 'fill-close', planId: 'plan-1', timestamp: 3_000, symbol: 'BTC', side: 'sell',
        intent: 'close', quantity: 1, price: 202, notionalUsd: 202, feeUsd: 1, realizedPnlUsd: 102,
      }],
    })
    await journal.commit({
      commitId: 'run-3',
      snapshot: snapshot(3_000, 99_999),
    })

    const report = await journal.report({ from: 1_000, to: 4_000 })

    expect(report?.summary).toMatchObject({
      equityUsd: 10_200,
      maxDrawdownPct: -5,
      closedTrades: 1,
      winningTrades: 1,
      winRatePct: 100,
      profitFactor: null,
    })
    expect(report?.equity).toHaveLength(3)
    expect(report?.fills).toHaveLength(2)
    expect(report?.trades[0]).toMatchObject({
      planId: 'plan-1', status: 'closed', entryPrice: 100, exitPrice: 202,
      realizedPnlUsd: 102, feesUsd: 2, netPnlUsd: 100,
    })
    expect(report?.decisions).toHaveLength(1)
    expect(report?.marketBars).toHaveLength(1)
  })

  it('isolates instances and filters symbols', async () => {
    await journal.commit({
      commitId: 'run-1',
      snapshot: snapshot(1_000, 10_000),
      marketBars: [
        { symbol: 'BTC', timestamp: 1_000, open: 1, high: 2, low: 1, close: 2 },
        { symbol: 'ETH', timestamp: 1_000, open: 2, high: 3, low: 2, close: 3 },
      ],
    })
    const other = new PortfolioJournal('instance-2', db)
    await other.commit({ commitId: 'other', snapshot: snapshot(1_000, 20_000) })

    expect((await journal.report({ symbol: 'ETH' }))?.marketBars.map(bar => bar.symbol)).toEqual(['ETH'])
    expect((await journal.report())?.summary.equityUsd).toBe(10_000)
    expect((await other.report())?.summary.equityUsd).toBe(20_000)
  })

  it('keeps the newest bounded events and computes drawdown for the requested range', async () => {
    for (const [index, equityUsd] of [10_000, 5_000, 10_000, 9_000].entries()) {
      const timestamp = (index + 1) * 1_000
      await journal.commit({
        commitId: `run-${index}`,
        snapshot: snapshot(timestamp, equityUsd),
        decisions: [{ id: `decision-${index}`, timestamp, symbol: 'BTC', action: 'HOLD' }],
        marketBars: [{ symbol: 'BTC', timestamp, open: index, high: index + 1, low: index, close: index + 1 }],
      })
    }

    const report = await journal.report({ from: 3_000, to: 4_000, limit: 2 })

    expect(report?.summary.maxDrawdownPct).toBe(-10)
    expect(report?.equity.map(point => point.timestamp)).toEqual([3_000, 4_000])
    expect(report?.decisions.map(decision => decision.timestamp)).toEqual([3_000, 4_000])
    expect(report?.marketBars.map(bar => bar.timestamp)).toEqual([3_000, 4_000])
  })
})

describe('模拟盘专用', () => {
  it('refuses a live snapshot — that account belongs to the pnl_* ledger', async () => {
    await expect(journal.commit({
      commitId: 'c-live',
      // 绕过类型：插件、反序列化的旧数据、JS 调用方都能做到这件事，
      // 所以 commit() 在运行期也要挡一道
      snapshot: { ...snapshot(1_000, 10_000), mode: 'live' as unknown as 'paper' },
    })).rejects.toThrow(/simulated trading only/)
  })

  it('leaves nothing behind when it refuses', async () => {
    // 拒绝必须发生在事务之前 —— 写进去一半的账比不写更难查
    await journal.commit({ commitId: 'c-ok', snapshot: snapshot(1_000, 10_000) })
    await expect(journal.commit({
      commitId: 'c-live-2',
      snapshot: { ...snapshot(2_000, 9_000), mode: 'live' as unknown as 'paper' },
    })).rejects.toThrow()
    const report = await journal.report()
    expect(report?.equity).toHaveLength(1)
  })
})
