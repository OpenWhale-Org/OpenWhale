import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MonitorDataReaderImpl } from '../MonitorDataReader.js'

describe('MonitorDataReader torn lines', () => {
  it('skips a half-written line and keeps the records around it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-torn-'))
    const line = (ts: number) => JSON.stringify({ ts, data: { v: ts } })
    fs.writeFileSync(path.join(dir, 'k.jsonl'), `${line(1)}\n{"ts":2,"da${line(3)}\n${line(4)}\n`)
    const reader = new MonitorDataReaderImpl(dir)
    expect((await reader.readAll('k')).map(r => r.ts)).toEqual([1, 4])
    expect((await reader.readLast('k', 10)).map(r => r.ts)).toEqual([1, 4])
  })
})
