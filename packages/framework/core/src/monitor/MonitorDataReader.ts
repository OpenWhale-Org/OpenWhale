import fs from 'fs'
import path from 'path'
import type { MonitorDataReader, MonitorRecord } from '../types/monitor.js'
import { streamJsonlLines } from '../utils/jsonl.js'

/**
 * Parsed records, shared across readers of the same file.
 *
 * Small files are slurped once and cached — one dashboard refresh asks four
 * panels for the same key, and re-parsing per panel is pure waste. Keyed by
 * (path, mtime, size) so an appended file invalidates itself.
 *
 * Files past `slurpLimit` are NEVER slurped or cached: a three-month
 * settlement store is >130MB of JSON, and materializing it as one string plus
 * a line array plus the object tree — concurrently once per caller — is what
 * OOM-killed the 1.9GB production gateway (2026-07-31, both on dashboard
 * views AND on the hourly settlement evaluation). Every read of an oversized
 * file streams line by line, with memory bounded by the ANSWER (the n
 * requested, the range matched), not the file.
 */
const parseCache = new Map<string, { stamp: string; records: unknown[] }>()
/** Enough to hold the handful of keys a refresh touches, not a leak. */
const PARSE_CACHE_MAX = 8
/** Concurrent misses on the same file share ONE parse instead of racing. */
const inFlight = new Map<string, Promise<unknown[]>>()

const DEFAULT_SLURP_LIMIT = 16 * 1024 * 1024

/**
 * readLast on an oversized file reads BACKWARDS from the end in chunks until
 * enough complete lines are in hand — O(answer), not O(file). A settlement
 * board click was re-scanning 131MB per panel per filter change; the tail of
 * the file is all anyone asked for.
 */
const TAIL_CHUNK = 1 << 20

/** One recent tail per file — filter clicks land seconds apart on an
 * append-rarely store, so (stamp, n) stays valid across a whole session of
 * clicking. Single slot: this cache exists to absorb click storms, not to
 * hold data sets. */
let tailCache: { file: string; stamp: string; n: number; records: unknown[] } | null = null
const tailInFlight = new Map<string, Promise<unknown[]>>()
/** Line count of an oversized file is a full scan — remember it per stamp. */
let countCache: { file: string; stamp: string; n: number } | null = null

export class MonitorDataReaderImpl<TData = Record<string, unknown>>
  implements MonitorDataReader<TData>
{
  private readonly slurpLimit: number

  /** Base directory for this monitor: {dataDir}/monitors/{monitorName}/ */
  constructor(private readonly monitorDir: string, options?: { slurpLimit?: number }) {
    this.slurpLimit = options?.slurpLimit ?? DEFAULT_SLURP_LIMIT
  }

  /**
   * Every stored record for a key, oldest first.
   *
   * Deliberately unbounded: consumers that fit models over history (the
   * settlement profile pools every session of a venue) must not have their
   * evidence silently truncated by a caller-side default. Oversized files are
   * stream-parsed — the object tree still accumulates, but never the raw
   * string and line array on top of it.
   */
  async readAll(key: string): Promise<MonitorRecord<TData>[]> {
    if (await this.oversized(key)) {
      const out: MonitorRecord<TData>[] = []
      for await (const r of this.stream(key)) out.push(r)
      return out
    }
    return this.load(key)
  }

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
    if (await this.oversized(key)) return this.tailRecords(key, n)
    const all = await this.load(key)
    return all.slice(-n)
  }

  /** Backwards chunked read of the last n records; deduped and cached per (file, stamp, n). */
  private async tailRecords(key: string, n: number): Promise<MonitorRecord<TData>[]> {
    const file = this.filePath(key)
    let stat
    try {
      stat = await fs.promises.stat(file)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (tailCache && tailCache.file === file && tailCache.stamp === stamp && tailCache.n === n)
      return tailCache.records as MonitorRecord<TData>[]

    const flightKey = `${file}\n${stamp}\n${n}`
    const flying = tailInFlight.get(flightKey)
    if (flying) return (await flying) as MonitorRecord<TData>[]

    const read = (async () => {
      const fh = await fs.promises.open(file, 'r')
      try {
        let pos = stat.size
        let acc = Buffer.alloc(0)
        // Byte-level accumulation: a UTF-8 char split at a chunk seam stays
        // intact because decoding happens once, after the seams are joined.
        while (pos > 0) {
          const size = Math.min(TAIL_CHUNK, pos)
          pos -= size
          const chunk = Buffer.alloc(size)
          await fh.read(chunk, 0, size, pos)
          acc = Buffer.concat([chunk, acc])
          let newlines = 0
          for (let i = 0; i < acc.length; i++) if (acc[i] === 0x0a) newlines++
          // n+1 newlines guarantee n COMPLETE lines even if the front is partial.
          if (newlines > n) break
        }
        let text = acc.toString('utf8')
        // Reading mid-file: the front fragment belongs to a line we did not
        // fully read — drop through the first newline.
        if (pos > 0) text = text.slice(text.indexOf('\n') + 1)
        const records = text
          .split('\n')
          .filter(l => l.trim().length > 0)
          .slice(-n)
          .map(l => JSON.parse(l) as MonitorRecord<TData>)
        tailCache = { file, stamp, n, records }
        return records
      } finally {
        await fh.close()
      }
    })()
    tailInFlight.set(flightKey, read)
    try {
      return (await read) as MonitorRecord<TData>[]
    } finally {
      tailInFlight.delete(flightKey)
    }
  }

  /** True when this key's store is past the slurp limit — display layers cap their windows on this. */
  async isOversized(key: string): Promise<boolean> {
    return this.oversized(key)
  }

  async readLatest(key: string): Promise<MonitorRecord<TData> | null> {
    const last = await this.readLast(key, 1)
    return last[last.length - 1] ?? null
  }

  async readRange(key: string, from: number, to: number): Promise<MonitorRecord<TData>[]> {
    if (await this.oversized(key)) {
      const out: MonitorRecord<TData>[] = []
      for await (const r of this.stream(key)) {
        if (r.ts >= from && r.ts <= to) out.push(r)
      }
      return out
    }
    const all = await this.load(key)
    return all.filter(r => r.ts >= from && r.ts <= to)
  }

  async count(key: string): Promise<number> {
    if (await this.oversized(key)) {
      const file = this.filePath(key)
      const stat = await fs.promises.stat(file)
      const stamp = `${stat.mtimeMs}:${stat.size}`
      if (countCache && countCache.file === file && countCache.stamp === stamp) return countCache.n
      let n = 0
      for await (const _ of this.stream(key)) n++
      countCache = { file, stamp, n }
      return n
    }
    // Small files ride the parse cache instead of a second full read.
    return (await this.load(key)).length
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

  private async oversized(key: string): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(this.filePath(key))
      return stat.size > this.slurpLimit
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  private async load(key: string): Promise<MonitorRecord<TData>[]> {
    const filePath = this.filePath(key)
    try {
      const stat = await fs.promises.stat(filePath)
      const stamp = `${stat.mtimeMs}:${stat.size}`
      const hit = parseCache.get(filePath)
      if (hit && hit.stamp === stamp) return hit.records as MonitorRecord<TData>[]

      // One parse per file, no matter how many callers miss at once.
      const flying = inFlight.get(filePath)
      if (flying) return (await flying) as MonitorRecord<TData>[]

      const parse = (async () => {
        const content = await fs.promises.readFile(filePath, 'utf8')
        const records = content
          .split('\n')
          .filter(l => l.trim().length > 0)
          .map(l => JSON.parse(l) as MonitorRecord<TData>)

        // Re-stat: an append between the stat and the read would cache records
        // under a stamp that no longer describes them, and the staleness would
        // persist until the NEXT write.
        const after = await fs.promises.stat(filePath)
        if (`${after.mtimeMs}:${after.size}` === stamp) {
          if (parseCache.size >= PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value!)
          parseCache.set(filePath, { stamp, records })
        }
        return records
      })()
      inFlight.set(filePath, parse)
      try {
        return (await parse) as MonitorRecord<TData>[]
      } finally {
        inFlight.delete(filePath)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
  }
}
