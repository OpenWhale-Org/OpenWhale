import fs from 'fs'
import readline from 'readline'

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

/**
 * Drop records older than `cutoffMs` from a JSONL store.
 *
 * A line whose `ts` cannot be read is KEPT. Retention runs unattended against
 * files whose shape comes from third-party plugins, and the failure modes are
 * not symmetric: keeping a line nobody can parse costs bytes, dropping one
 * loses data with no way back.
 */
export async function pruneJsonlByTime(
  filePath: string,
  cutoffMs: number,
  opts: { dryRun?: boolean } = {},
): Promise<PruneResult> {
  const stat = await fs.promises.stat(filePath)
  const bytesBefore = stat.size
  const idle: PruneResult = { bytesBefore, bytesAfter: bytesBefore, kept: 0, dropped: 0, untouched: true }
  if (bytesBefore === 0) return idle

  const handle = await fs.promises.open(filePath, 'r')
  let boundary: number
  try {
    boundary = await lastLineBoundary(handle, bytesBefore)
  } finally {
    await handle.close()
  }
  if (boundary === 0) return idle

  const tmp = `${filePath}.prune.tmp`
  const out = opts.dryRun ? null : fs.createWriteStream(tmp, { encoding: 'utf8' })
  let kept = 0
  let dropped = 0
  let keptBytes = 0

  try {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { start: 0, end: boundary - 1, encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    for await (const line of rl) {
      if (line.length === 0) continue
      let keep = true
      try {
        const ts = (JSON.parse(line) as { ts?: unknown }).ts
        if (typeof ts === 'number' && ts < cutoffMs) keep = false
      } catch { /* unparseable — keep it, see the note above */ }
      if (!keep) { dropped++; continue }
      kept++
      keptBytes += Buffer.byteLength(line) + 1
      if (out && !out.write(`${line}\n`)) await new Promise<void>(res => out.once('drain', () => res()))
    }

    if (!out) return { bytesBefore, bytesAfter: keptBytes + (bytesBefore - boundary), kept, dropped, untouched: true }
    if (dropped === 0) { await closeStream(out); await fs.promises.rm(tmp, { force: true }); return { ...idle, kept } }

    // Everything appended since the boundary was measured, byte for byte.
    await new Promise<void>((resolve, reject) => {
      const tail = fs.createReadStream(filePath, { start: boundary })
      tail.on('error', reject)
      out.on('error', reject)
      out.on('finish', resolve)
      tail.pipe(out)
    })
    await fs.promises.rename(tmp, filePath)
    const after = await fs.promises.stat(filePath)
    return { bytesBefore, bytesAfter: after.size, kept, dropped, untouched: false }
  } catch (err) {
    if (out) await closeStream(out).catch(() => { /* already broken */ })
    await fs.promises.rm(tmp, { force: true })
    throw err
  }
}
