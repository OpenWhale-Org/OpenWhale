import fs from 'fs'

/**
 * Time-based pruning for monitor stores.
 *
 * Monitor files are append-only JSONL and nothing has ever deleted from them:
 * a funding-rates collector writes a full market snapshot every minute and the
 * file had reached 5.8GB after a month. The reader already refuses to slurp
 * anything over 16MB, so size does not threaten the process — it threatens the
 * disk, and only the disk. That makes retention a housekeeping concern, not a
 * correctness one, which is why it is opt-in per store rather than a global
 * default: some of these files ARE the historical record a strategy fits its
 * baseline against, and silently trimming those would corrupt a live edge.
 *
 * Two properties of the format make an in-place rewrite safe:
 *
 *   1. Records carry `ts` and are appended in time order, so "old" is a prefix.
 *   2. Collectors only ever APPEND, so bytes already written never move.
 *
 * The rewrite therefore works on a byte-bounded prefix ending at the last
 * newline seen at the start of the pass, and copies everything after that
 * boundary through verbatim. Anything a collector appends mid-pass lands past
 * the boundary and survives untouched — including a half-written line, which
 * is copied as raw bytes rather than re-serialized.
 */

/** One line's worth of decision — the shape a caller can count. */
export interface PruneResult {
  /** Bytes the file occupied before the pass. */
  bytesBefore: number
  /** Bytes it occupies after (equals bytesBefore on a dry run). */
  bytesAfter: number
  /** Records kept, including everything past the boundary. */
  kept: number
  /** Records dropped for being older than the cutoff. */
  dropped: number
  /** True when nothing was written — either a dry run or nothing to drop. */
  untouched: boolean
}

/**
 * Glob over a monitor key: `*` spans any run of characters, `?` exactly one.
 * Deliberately not a regex — these patterns are typed into a form field by
 * someone naming exchange keys like `binance:SNXX/USDT:USDT`, and a stray
 * regex metacharacter in a symbol should match itself, not blow up.
 */
export function matchesKeyPattern(key: string, pattern: string): boolean {
  if (pattern === '*' || pattern === '') return true
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const rx = new RegExp(`^${escaped.split('*').join('.*').split('?').join('.')}$`)
  return rx.test(key)
}

/**
 * End a write stream and wait for its queue to flush.
 *
 * NOT destroy(): writes that returned `true` are still in flight, and tearing
 * the stream down under them throws ERR_STREAM_DESTROYED from an fs callback —
 * asynchronously, with no caller left to catch it.
 */
function closeStream(s: fs.WriteStream): Promise<void> {
  return new Promise(resolve => { s.end(() => resolve()) })
}

/** The offset just past the final newline in `[0, limit)`, or 0 if there is none. */
async function lastLineBoundary(handle: fs.promises.FileHandle, limit: number): Promise<number> {
  const CHUNK = 64 * 1024
  let end = limit
  while (end > 0) {
    const start = Math.max(0, end - CHUNK)
    const buf = Buffer.alloc(end - start)
    await handle.read(buf, 0, buf.length, start)
    const idx = buf.lastIndexOf(0x0a)
    if (idx !== -1) return start + idx + 1
    end = start
  }
  return 0
}

/** Records a line starts with, when BaseMonitor wrote it: `{"ts":<ms>,…`. */
const TS_PREFIX = Buffer.from('{"ts":')

/**
 * The `ts` of the line in `buf[start, end)`, or undefined if it has none that
 * can be read.
 *
 * Reads the leading bytes only. Every line BaseMonitor appends begins
 * `{"ts":<integer>`, so for those the timestamp is digits at a fixed offset
 * and the rest of the line — an order book, twenty levels a side — is never
 * decoded. Parsing whole lines is what made a pass over sixteen order-book
 * stores take the process to 100% CPU for half an hour on 2026-09-14, to free
 * 31MB of 5GB. Only a line of some other shape pays for a full parse.
 */
export function readLineTs(buf: Buffer, start: number, end: number): number | undefined {
  if (end - start > TS_PREFIX.length && buf.compare(TS_PREFIX, 0, TS_PREFIX.length, start, start + TS_PREFIX.length) === 0) {
    let i = start + TS_PREFIX.length
    let n = 0
    let digits = 0
    while (i < end && buf[i]! >= 0x30 && buf[i]! <= 0x39) { n = n * 10 + (buf[i]! - 0x30); i++; digits++ }
    if (digits > 0 && digits <= 16 && i < end && (buf[i] === 0x2c || buf[i] === 0x7d)) return n
  }
  try {
    const ts = (JSON.parse(buf.toString('utf8', start, end)) as { ts?: unknown }).ts
    return typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined
  } catch {
    return undefined
  }
}

const PROBE_CHUNK = 256 * 1024

/**
 * From byte `pos`, the first line that carries a readable `ts`: its start and
 * its value. When `skipPartial` the scan begins at the NEXT line — `pos` was
 * chosen by arithmetic and usually lands mid-line.
 */
async function firstReadableFrom(
  handle: fs.promises.FileHandle,
  pos: number,
  limit: number,
  skipPartial: boolean,
): Promise<{ lineStart: number; ts: number } | undefined> {
  let offset = pos
  let carry: Buffer = Buffer.alloc(0)
  let carryStart = pos
  let skipping = skipPartial && pos > 0
  while (offset < limit) {
    const want = Math.min(PROBE_CHUNK, limit - offset)
    const chunk = Buffer.alloc(want)
    const { bytesRead } = await handle.read(chunk, 0, want, offset)
    if (bytesRead === 0) break
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead)
    const base = carry.length > 0 ? carryStart : offset
    let i = 0
    while (true) {
      const nl = buf.indexOf(0x0a, i)
      if (nl === -1) break
      if (skipping) { skipping = false; i = nl + 1; continue }
      const ts = readLineTs(buf, i, nl)
      if (ts !== undefined) return { lineStart: base + i, ts }
      i = nl + 1
    }
    carry = buf.subarray(i)
    carryStart = base + i
    offset += bytesRead
  }
  return undefined
}

/**
 * Drop records older than `cutoffMs` from a JSONL store.
 *
 * A line whose `ts` cannot be read is KEPT. Retention runs unattended against
 * files whose shape comes from third-party plugins, and the failure modes are
 * not symmetric: keeping a line nobody can parse costs bytes, dropping one
 * loses data with no way back.
 *
 * Finding what to drop does not read the file. Readable timestamps are in
 * append order (property 1 above), so the first record at or past the cutoff
 * is found by bisection over byte offsets — a few dozen small reads, whatever
 * the size. Only the prefix before it is walked line by line, to spare the
 * unreadable lines in it; everything after is copied as bytes. If the order
 * assumption is ever wrong, the error lands on the safe side: an out-of-order
 * old record past the boundary is kept, never a new one dropped.
 *
 * `minDropFraction` skips the rewrite when the prefix is a smaller share of
 * the file than that. Seven days of retention swept hourly frees 0.6% of a
 * file per pass, and rewriting 400MB to reclaim 2.5MB is the cost the sweep
 * exists to avoid.
 */
export async function pruneJsonlByTime(
  filePath: string,
  cutoffMs: number,
  opts: { dryRun?: boolean; minDropFraction?: number } = {},
): Promise<PruneResult> {
  const stat = await fs.promises.stat(filePath)
  const bytesBefore = stat.size
  const idle: PruneResult = { bytesBefore, bytesAfter: bytesBefore, kept: 0, dropped: 0, untouched: true }
  if (bytesBefore === 0) return idle

  const handle = await fs.promises.open(filePath, 'r')
  let boundary: number
  let cut: number
  try {
    boundary = await lastLineBoundary(handle, bytesBefore)
    if (boundary === 0) return idle

    // Nothing readable before the cutoff at the head means nothing anywhere.
    const first = await firstReadableFrom(handle, 0, boundary, false)
    if (first === undefined || first.ts >= cutoffMs) return idle

    // Bisect for the first readable record at or past the cutoff.
    let lo = first.lineStart
    let hi = boundary
    while (hi - lo > PROBE_CHUNK) {
      const mid = lo + Math.floor((hi - lo) / 2)
      const p = await firstReadableFrom(handle, mid, hi, true)
      if (p === undefined || p.lineStart >= hi) { hi = mid; continue }
      if (p.ts < cutoffMs) lo = p.lineStart
      else hi = p.lineStart
    }
    // Settle the last stretch exactly: walk forward from `lo` to the first
    // record at or past the cutoff. `hi` bounds the answer only loosely once
    // the loop has set it to a mid-line offset, so do not stop there.
    let settle = lo
    cut = boundary
    for (;;) {
      const p = await firstReadableFrom(handle, settle, boundary, settle !== lo)
      if (p === undefined) break
      if (p.ts >= cutoffMs) { cut = p.lineStart; break }
      settle = p.lineStart + 1
    }
  } finally {
    await handle.close()
  }

  if ((opts.minDropFraction ?? 0) > 0 && cut / bytesBefore < opts.minDropFraction!) return idle

  // Walk the prefix only: the unreadable lines in it survive, the old ones go.
  const keepRanges: Array<[number, number]> = []
  let dropped = 0
  let kept = 0
  {
    const rl = fs.createReadStream(filePath, { start: 0, end: cut - 1, highWaterMark: PROBE_CHUNK })
    let carry: Buffer = Buffer.alloc(0)
    let base = 0
    for await (const raw of rl) {
      const chunk = raw as Buffer
      const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
      let i = 0
      while (true) {
        const nl = buf.indexOf(0x0a, i)
        if (nl === -1) break
        if (nl > i) {
          const ts = readLineTs(buf, i, nl)
          if (ts !== undefined && ts < cutoffMs) {
            dropped++
          } else {
            kept++
            const s0 = base + i, e0 = base + nl + 1
            const last = keepRanges[keepRanges.length - 1]
            if (last && last[1] === s0) last[1] = e0
            else keepRanges.push([s0, e0])
          }
        }
        i = nl + 1
      }
      carry = buf.subarray(i)
      base += i
    }
  }
  if (dropped === 0) return idle

  const tailLines = async (start: number, end: number): Promise<number> => {
    if (end <= start) return 0
    let n = 0
    for await (const raw of fs.createReadStream(filePath, { start, end: end - 1, highWaterMark: PROBE_CHUNK })) {
      const b = raw as Buffer
      for (let j = b.indexOf(0x0a); j !== -1; j = b.indexOf(0x0a, j + 1)) n++
    }
    return n
  }

  if (opts.dryRun) {
    const keptBytes = keepRanges.reduce((a, [x, y]) => a + (y - x), 0) + (boundary - cut)
    return { bytesBefore, bytesAfter: keptBytes + (bytesBefore - boundary), kept: kept + await tailLines(cut, boundary), dropped, untouched: true }
  }

  const tmp = `${filePath}.prune.tmp`
  const out = fs.createWriteStream(tmp)
  const copy = (start: number, end?: number, count = false): Promise<number> => new Promise((resolve, reject) => {
    let n = 0
    if (end !== undefined && end <= start) { resolve(0); return }
    const src = fs.createReadStream(filePath, { start, ...(end !== undefined ? { end: end - 1 } : {}), highWaterMark: PROBE_CHUNK })
    src.on('error', reject)
    src.on('data', (raw) => {
      const b = raw as Buffer
      if (count) for (let j = b.indexOf(0x0a); j !== -1; j = b.indexOf(0x0a, j + 1)) n++
      if (!out.write(b)) { src.pause(); out.once('drain', () => src.resume()) }
    })
    src.on('end', () => resolve(n))
  })
  try {
    for (const [x, y] of keepRanges) await copy(x, y)
    kept += await copy(cut, boundary, true)
    // Everything appended since the boundary was measured, byte for byte.
    await copy(boundary)
    await closeStream(out)
    await fs.promises.rename(tmp, filePath)
    const after = await fs.promises.stat(filePath)
    return { bytesBefore, bytesAfter: after.size, kept, dropped, untouched: false }
  } catch (err) {
    await closeStream(out).catch(() => { /* already broken */ })
    await fs.promises.rm(tmp, { force: true })
    throw err
  }
}
