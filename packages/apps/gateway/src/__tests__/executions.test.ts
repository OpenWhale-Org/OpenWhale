import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readExecutions } from '../executions.js'

/**
 * The execution log is ordered per executor per day and nothing else. These
 * pin the two things the Executions page depends on: newest-first ACROSS
 * executors, and a page size that is honoured after filtering rather than
 * before it.
 */

let dataDir: string

function write(executorId: string, day: string, records: Array<Record<string, unknown>>): void {
  const dir = path.join(dataDir, 'executions', executorId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${day}.jsonl`), records.map(r => JSON.stringify(r)).join('\n') + '\n')
}

const record = (at: string, over: Record<string, unknown> = {}) => ({
  instruction: { messageId: at, action: 'place', instanceId: 'inst_a', runId: `run:inst_a:${at}` },
  status: 'success',
  executedAt: at,
  ...over,
})

beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-exec-')) })
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }) })

describe('readExecutions', () => {
  it('merges executors into one newest-first list', async () => {
    write('ccxt', '2026-09-01', [record('2026-09-01T10:00:00.000Z'), record('2026-09-01T12:00:00.000Z')])
    write('boros', '2026-09-01', [record('2026-09-01T11:00:00.000Z')])

    const rows = await readExecutions(dataDir)
    expect(rows.map(r => r.executedAt)).toEqual([
      '2026-09-01T12:00:00.000Z',
      '2026-09-01T11:00:00.000Z',
      '2026-09-01T10:00:00.000Z',
    ])
    expect(rows[0]!.executorId).toBe('ccxt')
    expect(rows[1]!.executorId).toBe('boros')
  })

  it('carries the run id through, which is what links a row to its trace', async () => {
    write('ccxt', '2026-09-01', [record('2026-09-01T10:00:00.000Z')])
    expect((await readExecutions(dataDir))[0]!.instruction.runId).toBe('run:inst_a:2026-09-01T10:00:00.000Z')
  })

  it('filters by instance and by status', async () => {
    write('ccxt', '2026-09-01', [
      record('2026-09-01T10:00:00.000Z'),
      record('2026-09-01T11:00:00.000Z', { instruction: { instanceId: 'inst_b' } }),
      record('2026-09-01T12:00:00.000Z', { status: 'failed', error: 'venue said no' }),
    ])

    expect(await readExecutions(dataDir, { instanceId: 'inst_b' })).toHaveLength(1)
    const failed = await readExecutions(dataDir, { status: 'failed' })
    expect(failed).toHaveLength(1)
    expect(failed[0]!.error).toBe('venue said no')
  })

  it('fills the page with matching rows, not with rows it then discards', async () => {
    write('ccxt', '2026-09-01', Array.from({ length: 40 }, (_, i) =>
      record(`2026-09-01T10:${String(i).padStart(2, '0')}:00.000Z`, i % 2 ? { status: 'skipped' } : {})))

    const rows = await readExecutions(dataDir, { status: 'success', limit: 10 })
    expect(rows).toHaveLength(10)
    expect(rows.every(r => r.status === 'success')).toBe(true)
  })

  it('reads yesterday too, so the list is not empty just after UTC midnight', async () => {
    write('ccxt', '2026-08-31', [record('2026-08-31T23:59:00.000Z')])
    write('ccxt', '2026-09-01', [record('2026-09-01T00:01:00.000Z')])
    expect(await readExecutions(dataDir)).toHaveLength(2)
  })

  it('skips a torn tail write instead of failing the page', async () => {
    const dir = path.join(dataDir, 'executions', 'ccxt')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '2026-09-01.jsonl'),
      JSON.stringify(record('2026-09-01T10:00:00.000Z')) + '\n{"instruction":{"act')

    expect(await readExecutions(dataDir)).toHaveLength(1)
  })

  it('is empty, not an error, before anything has executed', async () => {
    expect(await readExecutions(dataDir)).toEqual([])
  })
})
