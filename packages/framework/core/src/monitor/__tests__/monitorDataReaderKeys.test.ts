import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { MonitorDataReaderImpl } from '../MonitorDataReader.js'
import { encodeMonitorKey } from '../../utils/paths.js'

describe('MonitorDataReader.keys()', () => {
  let dir = ''
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }) })

  it('lists keys stored as nested directories, not only the top level', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-reader-'))
    const keys = ['binance:binance:SNXX/USDT:USDT:SNDK/USDT:USDT:2:us', 'plain-key']
    for (const k of keys) {
      const file = path.join(dir, `${encodeMonitorKey(k)}.jsonl`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ ts: 1, data: { v: 1 } }) + '\n')
    }
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a key')
    const reader = new MonitorDataReaderImpl(dir)
    expect((await reader.keys()).sort()).toEqual([...keys].sort())
    expect((await reader.readLatest(keys[0]!))?.data).toEqual({ v: 1 })
  })

  it('a monitor with no data directory has no keys', async () => {
    expect(await new MonitorDataReaderImpl(path.join(os.tmpdir(), 'ow-reader-missing-' + Date.now())).keys()).toEqual([])
  })
})
