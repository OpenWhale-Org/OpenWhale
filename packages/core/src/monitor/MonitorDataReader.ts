import fs from 'fs'
import readline from 'readline'
import type { MonitorDataReader, MonitorRecord } from '../types/monitor.js'
import { streamJsonlLines } from '../utils/jsonl.js'

export class MonitorDataReaderImpl<TData = Record<string, unknown>>
  implements MonitorDataReader<TData>
{
  constructor(private readonly filePath: string) {}

  async readLast(n: number): Promise<MonitorRecord<TData>[]> {
    const all = await this.readAll()
    return all.slice(-n)
  }

  async readLatest(): Promise<MonitorRecord<TData> | null> {
    const all = await this.readAll()
    return all[all.length - 1] ?? null
  }

  async readRange(from: number, to: number): Promise<MonitorRecord<TData>[]> {
    const all = await this.readAll()
    return all.filter((r) => r.ts >= from && r.ts <= to)
  }

  async count(): Promise<number> {
    try {
      const content = await fs.promises.readFile(this.filePath, 'utf8')
      return content.split('\n').filter((l) => l.trim().length > 0).length
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }
  }

  stream(): AsyncIterable<MonitorRecord<TData>> {
    return streamJsonlLines<MonitorRecord<TData>>(this.filePath)
  }

  private async readAll(): Promise<MonitorRecord<TData>[]> {
    try {
      const content = await fs.promises.readFile(this.filePath, 'utf8')
      return content
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as MonitorRecord<TData>)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }
}
