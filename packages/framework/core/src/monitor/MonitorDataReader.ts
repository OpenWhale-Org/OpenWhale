import fs from 'fs'
import path from 'path'
import type { MonitorDataReader, MonitorRecord } from '../types/monitor.js'
import { streamJsonlLines } from '../utils/jsonl.js'
import { encodeMonitorKey, decodeMonitorKey } from '../utils/paths.js'

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
/**
 * Line counts, remembered per file and advanced incrementally.
 *
 * Counting used to stream the whole file THROUGH THE JSON PARSER and throw
 * every record away — 431,020 records off a 178MB store measured at 2.51s of
 * CPU on 2026-09-10, and `funding-rates/binance.jsonl` had reached 7.5GB, so
 * one count of it is ~105s and ~18M objects of garbage. That garbage is what
 * the multi-second parallel GC pauses were: the gateway showed 100-171% CPU
 * for fourteen seconds at a stretch while every API call queued behind it.
 *
 * Worse, the old cache key was `mtimeMs:size` — both of which change on every
 * append, and these stores are appended ~20x a second. The cache could never
 * hit, so EVERY request full-scanned. `/api/monitor/:name/:key` calls this to
 * put a row count in the UI.
 *
 * Two changes. Counting reads bytes and counts 0x0a, never parsing — a count
 * does not need the records. And the entry remembers where it stopped, so an
 * append-only store is advanced by counting the newlines in the bytes ADDED
 * since last time, which is a few KB rather than gigabytes.
 *
 * `head` guards the one case that is not append-only: retention prunes by
 * rewriting the file from the front, so a changed head means our offset is
 * meaningless and the count starts over.
 */
const HEAD_PROBE = 256
const COUNT_CACHE_MAX = 64
/** `nl` is the RAW newline count over [0, size) — see `count` for why. */
const countCache = new Map<string, { size: number; head: string; nl: number }>()

/** Newlines in [from, to) — bytes only, no parse, no per-record allocation. */
async function countNewlines(file: string, from: number, to: number): Promise<number> {
  if (to <= from) return 0
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(Math.min(1 << 20, to - from))
    let pos = from, n = 0
    while (pos < to) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, to - pos), pos)
      if (bytesRead <= 0) break
      for (let i = 0; i < bytesRead; i++) if (buf[i] === 0x0a) n++
      pos += bytesRead
    }
    return n
  } finally {
    await fh.close()
  }
}

async function readHead(file: string, bytes: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('latin1')
  } finally {
    await fh.close()
  }
}

/** Is the file's last byte a newline? Decides whether a final record is unterminated. */
async function endsWithNewline(file: string, size: number): Promise<boolean> {
  if (size <= 0) return true
  const fh = await fs.promises.open(file, 'r')
  try {
    const buf = Buffer.alloc(1)
    await fh.read(buf, 0, 1, size - 1)
    return buf[0] === 0x0a
  } finally {
    await fh.close()
  }
}

/** `ts` off a stored line: the prefix when it is BaseMonitor's shape, a parse otherwise. */
function readTs(text: string): number | undefined {
  const m = /^\{"ts":(\d+)/.exec(text)
  if (m) return Number(m[1])
  try {
    const ts = (JSON.parse(text) as { ts?: unknown }).ts
    return typeof ts === 'number' ? ts : undefined
  } catch {
    return undefined
  }
}

/** The in-memory version: the record nearest each of `points` evenly spaced instants. */
export function sampleByTime<T extends { ts: number }>(records: T[], points: number): T[] {
  if (records.length <= points || records.length === 0) return records
  const t0 = records[0]!.ts, t1 = records[records.length - 1]!.ts
  const out: T[] = []
  let i = 0
  for (let p = 0; p < points; p++) {
    const target = t0 + ((t1 - t0) * p) / Math.max(1, points - 1)
    while (i < records.length - 1 && Math.abs(records[i + 1]!.ts - target) <= Math.abs(records[i]!.ts - target)) i++
    if (out[out.length - 1] !== records[i]) out.push(records[i]!)
  }
  return out
}

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

  /**
   * Every key with a data file. Walks subdirectories: where the platform does
   * not encode `/`, a key like `binance:binance:SNXX/USDT:USDT:…` is stored as
   * nested directories, and a top-level-only listing never saw a single
   * contract-named key (the gateway's walkJsonl already walked them).
   */
  async keys(): Promise<string[]> {
    const out: string[] = []
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      for (const e of entries) {
        if (e.isDirectory()) await walk(path.join(dir, e.name), `${prefix}${e.name}/`)
        else if (e.name.endsWith('.jsonl')) out.push(decodeMonitorKey(`${prefix}${e.name.slice(0, -6)}`))  // strip '.jsonl', undo the path-safe encoding
      }
    }
    await walk(this.monitorDir, '')
    return out
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

  /**
   * About `points` records spread evenly over the store's TIME span, read
   * without scanning it — for "the whole history" of a store too large to
   * load.
   *
   * Asking an oversized store for everything used to return its newest 1000
   * records: on a store written once a second that is the last 17 minutes
   * labelled "all history" (etf-engine-quotes, 2026-09-14). Byte offsets are
   * probed evenly to learn where time is in the file, then each time target
   * takes the probed record nearest it. Where probes land far apart in TIME
   * but close in bytes — a sparse stretch, like hourly backfill before a
   * dense live one — that byte range is read whole, so the sparse stretch is
   * represented by its own records rather than skipped.
   *
   * Each record returned is a real record, not an average.
   */
  async readSampled(key: string, points: number): Promise<MonitorRecord<TData>[]> {
    if (!(await this.oversized(key))) return sampleByTime(await this.load(key), points)
    const file = this.filePath(key)
    const size = (await fs.promises.stat(file)).size
    const fh = await fs.promises.open(file, 'r')
    try {
      type Line = { start: number; ts: number; text: string }
      const lineAt = async (offset: number): Promise<Line | undefined> => {
        let chunk = 8192
        for (;;) {
          const buf = Buffer.alloc(Math.min(chunk, Math.max(0, size - offset)))
          if (buf.length === 0) return undefined
          const { bytesRead } = await fh.read(buf, 0, buf.length, offset)
          let from = 0
          if (offset > 0) {
            const nl = buf.indexOf(0x0a)
            if (nl < 0 || nl >= bytesRead - 1) { if (offset + bytesRead >= size || chunk >= 4 << 20) return undefined; chunk *= 4; continue }
            from = nl + 1
          }
          const end = buf.indexOf(0x0a, from)
          if (end < 0 || end >= bytesRead) { if (offset + bytesRead >= size || chunk >= 4 << 20) return undefined; chunk *= 4; continue }
          const text = buf.toString('utf8', from, end)
          const ts = readTs(text)
          if (ts === undefined) return lineAt(offset + end + 1)
          return { start: offset + from, ts, text }
        }
      }
      const probes = Math.min(4096, Math.max(64, points * 2))
      const samples: Line[] = []
      for (let i = 0; i <= probes; i++) {
        const line = await lineAt(Math.floor((size * i) / probes))
        if (line && (samples.length === 0 || line.start > samples[samples.length - 1]!.start)) samples.push(line)
      }
      if (samples.length === 0) return []
      const t0 = samples[0]!.ts, t1 = samples[samples.length - 1]!.ts
      const step = points > 1 ? (t1 - t0) / (points - 1) : 0
      const rangeCache = new Map<number, Line[]>()
      const readRange = async (j: number): Promise<Line[]> => {
        const hit = rangeCache.get(j)
        if (hit) return hit
        const a = samples[j]!, b = samples[j + 1]!
        const buf = Buffer.alloc(b.start - a.start)
        await fh.read(buf, 0, buf.length, a.start)
        const out: Line[] = []
        let from = 0
        for (let nl = buf.indexOf(0x0a); nl >= 0; nl = buf.indexOf(0x0a, from)) {
          const text = buf.toString('utf8', from, nl)
          const ts = readTs(text)
          if (ts !== undefined) out.push({ start: a.start + from, ts, text })
          from = nl + 1
        }
        rangeCache.set(j, out)
        return out
      }
      const chosen = new Map<number, Line>()
      let j = 0
      for (let p = 0; p < Math.max(1, points); p++) {
        const target = t0 + step * p
        while (j < samples.length - 2 && samples[j + 1]!.ts <= target) j++
        const a = samples[j]!, b = samples[Math.min(j + 1, samples.length - 1)]!
        let pick = Math.abs(a.ts - target) <= Math.abs(b.ts - target) ? a : b
        // Probes far apart in time but near in bytes: read what is between them.
        if (b !== a && b.ts - a.ts > 2 * step && b.start - a.start <= 256 * 1024) {
          for (const line of await readRange(j)) if (Math.abs(line.ts - target) < Math.abs(pick.ts - target)) pick = line
        }
        chosen.set(pick.start, pick)
      }
      return [...chosen.values()]
        .sort((x, y) => x.start - y.start)
        .flatMap((line) => { try { return [JSON.parse(line.text) as MonitorRecord<TData>] } catch { return [] } })
    } finally {
      await fh.close()
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
      const head = await readHead(file, HEAD_PROBE)
      const hit = countCache.get(file)
      // Append-only since we last looked: count the tail we have not seen.
      // A shrunken file or a rewritten head means retention has been through
      // it and the offset no longer means anything.
      const from = hit && hit.head === head && stat.size >= hit.size ? hit.size : 0
      const base = from > 0 ? hit!.nl : 0
      // Cache the RAW newline count, never the answer. A final record with no
      // terminator gets a +1 at return time; folding it into the cache would
      // double-count it the moment an append supplies the missing newline.
      const nl = base + await countNewlines(file, from, stat.size)
      if (countCache.size >= COUNT_CACHE_MAX && !countCache.has(file)) {
        countCache.delete(countCache.keys().next().value!)
      }
      countCache.set(file, { size: stat.size, head, nl })
      return nl + (await endsWithNewline(file, stat.size) ? 0 : 1)
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
    return path.join(this.monitorDir, `${encodeMonitorKey(key)}.jsonl`)
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
