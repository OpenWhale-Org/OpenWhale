import { homedir } from 'os'
import path from 'path'

/**
 * ~/.openwhale/
 * ├── credentials.jsonl                          — encrypted credential store
 * ├── monitors/                                  — monitor collected data
 * │   └── {monitorName}/
 * │       └── {key}.jsonl
 * ├── executions/                                — executor execution records
 * │   └── {executorName}/
 * │       └── {YYYY-MM-DD}.jsonl
 * ├── registry/                                  — metadata index for AI-compiled artifacts
 * │   ├── monitors/{id}.json
 * │   ├── executors/{id}.json
 * │   └── strategies/{id}.json
 * ├── compiled/                                  — AI-compiled artifact code
 * │   ├── monitors/{id}/source.ts + index.js
 * │   ├── executors/{id}/source.ts + index.js
 * │   └── strategies/{id}/source.ts + index.js
 * └── instances/                                 — StrategyInstance runtime config
 *     └── {id}.json
 */

export function getDataDir(custom?: string): string {
  return custom ?? path.join(homedir(), '.openwhale')
}

/**
 * Monitor keys carry venue prefixes and ccxt symbols that are illegal in file
 * names on Windows — `:` is forbidden in directory names there (POSIX tolerates
 * it), and a store containing `:` in its filenames cannot have been created on
 * Windows in the first place. So the encoding is gated on `win32`: Windows
 * percent-encodes the reserved set, POSIX passes the key through verbatim.
 *
 * Gating matters because POSIX stores already exist with `/` in keys, where the
 * OS silently turned `BTC/USDC` into a nested directory tree (up to gigabytes
 * across many files). Encoding on POSIX too would make every one of those series
 * invisible at once — readers return empty, no throw — and strategies that fit a
 * baseline over history silently restart from nothing. POSIX stays byte-identical
 * to today and needs no migration; Windows gets a store that works from scratch.
 *
 * The reserved set is percent-encoded (percent itself first, then the rest) so
 * the transform is a total bijection: `decode(encode(k)) === k` for every key,
 * including adversarial ones containing the encoded tokens literally. The set is
 * the full Windows-illegal group, because a venue-supplied symbol is not under
 * our control.
 *
 * CAVEAT: `process.platform` is a proxy for "this filesystem rejects `:`". The
 * two come apart under WSL, or a Windows-hosted volume mounted into a Linux
 * container, where the platform reads `linux` but the filesystem is still NTFS
 * (and still rejects `:`). Not solved here — but named so the next person hitting
 * a phantom ENOENT on such a mount knows where to look.
 */
const NEEDS_KEY_ENCODING = process.platform === 'win32'

// Percent-sign first so encoding the rest never collides with an encoded `%`.
// The remaining chars are the Windows-illegal set plus `/` (a path separator on
// every OS) — all of which appear in real monitor keys (`venue:symbol:tf`).
const KEY_ENCODE_CHARS: Record<string, string> = {
  '%': '%25', '/': '%2F', ':': '%3A', '\\': '%5C', '*': '%2A',
  '?': '%3F', '"': '%22', '<': '%3C', '>': '%3E', '|': '%7C',
}

export function encodeMonitorKey(key: string): string {
  if (!NEEDS_KEY_ENCODING) return key
  let out = key
  for (const [char, token] of Object.entries(KEY_ENCODE_CHARS)) {
    out = out.split(char).join(token)
  }
  return out
}

export function decodeMonitorKey(encoded: string): string {
  if (!NEEDS_KEY_ENCODING) return encoded
  // decodeURIComponent is the wider transform — it accepts any percent-escape
  // and throws URIError on a malformed one. Framework-written names are safe
  // (encode always escapes % first), but keys() and the gateway walkJsonl feed
  // raw filesystem names straight in, so a stray/half-written file (e.g.
  // `100%off`) must not take out the whole listing. Fail soft: return the name
  // verbatim when it cannot be decoded.
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

export function getMonitorPath(dataDir: string, monitorName: string, key: string): string {
  return path.join(dataDir, 'monitors', monitorName, `${encodeMonitorKey(key)}.jsonl`)
}

export function getExecutionPath(dataDir: string, executorName: string): string {
  const date = new Date().toISOString().slice(0, 10)
  return path.join(dataDir, 'executions', executorName, `${date}.jsonl`)
}

export function getCredentialPath(dataDir: string): string {
  return path.join(dataDir, 'credentials.jsonl')
}

export function getRegistryPath(dataDir: string, type: string, id: string): string {
  return path.join(dataDir, 'registry', type, `${id}.json`)
}

export function getCompiledSourcePath(dataDir: string, type: string, id: string): string {
  return path.join(dataDir, 'compiled', type, id, 'source.ts')
}

export function getCompiledOutputPath(dataDir: string, type: string, id: string): string {
  return path.join(dataDir, 'compiled', type, id, 'index.js')
}

export function getInstancePath(dataDir: string, id: string): string {
  return path.join(dataDir, 'instances', `${id}.json`)
}
