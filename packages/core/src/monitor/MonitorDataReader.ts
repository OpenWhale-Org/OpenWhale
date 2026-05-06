import fs from 'fs'
import path from 'path'
import type { MonitorDataReader, MonitorRecord } from '../types/monitor.js'
import { streamJsonlLines } from '../utils/jsonl.js'

export class MonitorDataReaderImpl<TData = Record<string, unknown>>
  implements MonitorDataReader<TData>
{
  /** Base directory for this monitor: {dataDir}/monitors/{monitorName}/ */
  constructor(private readonly monitorDir: string) {}

  async keys(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.monitorDir)
      return entries
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.slice(0, -6))  // strip '.jsonl'
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }

  async readLast(key: string, n: number): Promise<MonitorRecord<TData>[]> {
    const all = await this.readAll(key)
    return all.slice(-n)
  }

  async readLatest(key: string): Promise<MonitorRecord<TData> | null> {
    const all = await this.readAll(key)
    return all[all.length - 1] ?? null
  }

  async readRange(key: string, from: number, to: number): Promise<MonitorRecord<TData>[]> {
    const all = await this.readAll(key)
    return all.filter(r => r.ts >= from && r.ts <= to)
  }

  async count(key: string): Promise<number> {
    const filePath = this.filePath(key)
    try {
      const content = await fs.promises.readFile(filePath, 'utf8')
      return content.split('\n').filter(l => l.trim().length > 0).length
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }
  }

  stream(key: string): AsyncIterable<MonitorRecord<TData>> {
    return streamJsonlLines<MonitorRecord<TData>>(this.filePath(key))
  }

  async readAllLatest(): Promise<Map<string, MonitorRecord<TData> | null>> {
    const ks = await this.keys()
    const entries = await Promise.all(ks.map(async k => [k, await this.readLatest(k)] as const))
    return new Map(entries)
  }

  async readAllLast(n: number): Promise<Map<string, MonitorRecord<TData>[]>> {
    const ks = await this.keys()
    const entries = await Promise.all(ks.map(async k => [k, await this.readLast(k, n)] as const))
    return new Map(entries)
  }

  private filePath(key: string): string {
    return path.join(this.monitorDir, `${key}.jsonl`)
  }

  private async readAll(key: string): Promise<MonitorRecord<TData>[]> {
    const filePath = this.filePath(key)
    try {
      const content = await fs.promises.readFile(filePath, 'utf8')
      return content
        .split('\n')
        .filter(l => l.trim().length > 0)
        .map(l => JSON.parse(l) as MonitorRecord<TData>)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }
}
