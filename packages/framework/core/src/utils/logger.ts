import pino from 'pino'
import { createRequire } from 'module'
import { AsyncLocalStorage } from 'async_hooks'

export type LogLevel = pino.Level

export type Logger = pino.Logger

const isDev = process.env['NODE_ENV'] !== 'production'

/**
 * The dev-mode log prettifier, loaded only if it is both wanted and present.
 *
 * It used to be a top-level import declared as a devDependency — a runtime
 * import the published package did not ask npm to install, so
 * `@openwhaleorg/core` installed from the registry crashed on load with
 * "Cannot find package 'pino-pretty'". It is a real dependency now, but the
 * load stays guarded: a missing log formatter is not a reason for a trading
 * engine to refuse to start, and JSON on stdout is a perfectly good fallback.
 */
function prettyStream(): NodeJS.WritableStream {
  if (!isDev) return process.stdout
  try {
    const load = createRequire(import.meta.url)
    const pretty = load('pino-pretty') as (opts: unknown) => NodeJS.WritableStream
    return pretty({ colorize: true, ignore: 'pid,hostname' })
  } catch {
    return process.stdout
  }
}

// ── In-process log bus ────────────────────────────────────────────────────────
//
// Every log line also lands in a ring buffer and fans out to subscribers, so
// the dashboard can tail component logs (e.g. a running monitor) live without
// scraping stdout. Replaced loggers (setLogger) bypass the bus.

export interface LogRecord {
  ts: number
  level: string
  module?: string
  msg: string
  /** Structured fields beyond the standard ones. */
  extra: Record<string, unknown>
  /**
   * Which piece of work was running when this line was written — see
   * {@link runInLogScope}. Absent for anything logged outside one.
   */
  scope?: string
}

/**
 * Whose work is this line?
 *
 * Timestamps cannot answer that: a trading engine runs several strategies and
 * a dozen monitor feeds at once, so "logged between the start and end of run X"
 * catches every other component's lines too. A strategy run trace built that
 * way showed an Aster pair reading Binance order books for symbols it has
 * never heard of — over-inclusion that reads as a bug in the instance.
 *
 * AsyncLocalStorage answers it properly: a scope entered here follows the
 * async work started inside it, and nothing else. Whoever wants their logs
 * attributable wraps their work; everyone else logs unscoped as before.
 */
const logScope = new AsyncLocalStorage<string>()

/** Run `fn` with every log line it causes stamped with `scope`. */
export function runInLogScope<T>(scope: string, fn: () => T): T {
  return logScope.run(scope, fn)
}

const LOG_BUFFER_LIMIT = 2000
const logBuffer: LogRecord[] = []
const logListeners = new Set<(record: LogRecord) => void>()

const STANDARD_FIELDS = new Set(['level', 'time', 'pid', 'hostname', 'module', 'msg'])

const busStream = {
  write(line: string) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      const record: LogRecord = {
        ts: typeof parsed['time'] === 'number' ? parsed['time'] : Date.now(),
        level: pino.levels.labels[parsed['level'] as number] ?? String(parsed['level']),
        ...(typeof parsed['module'] === 'string' ? { module: parsed['module'] } : {}),
        msg: typeof parsed['msg'] === 'string' ? parsed['msg'] : '',
        extra: Object.fromEntries(Object.entries(parsed).filter(([k]) => !STANDARD_FIELDS.has(k))),
      }
      const scope = logScope.getStore()
      if (scope !== undefined) record.scope = scope
      logBuffer.push(record)
      if (logBuffer.length > LOG_BUFFER_LIMIT) logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT)
      for (const listener of logListeners) {
        try { listener(record) } catch { /* listener errors must not break logging */ }
      }
    } catch { /* non-JSON line — ignore */ }
  },
}

/** Live-tail the process's logs. Returns an unsubscribe function. */
export function subscribeLogs(listener: (record: LogRecord) => void): () => void {
  logListeners.add(listener)
  return () => logListeners.delete(listener)
}

/** Recent log records, optionally filtered by module, newest last. */
export function recentLogs(module?: string, n = 200): LogRecord[] {
  const source = module ? logBuffer.filter(r => r.module === module) : logBuffer
  return source.slice(-n)
}

// ── Root logger ───────────────────────────────────────────────────────────────

function buildRootLogger(): Logger {
  const level = process.env['LOG_LEVEL'] ?? 'info'
  const streams: pino.StreamEntry[] = [
    { level: 'trace', stream: prettyStream() },
    { level: 'trace', stream: busStream },
  ]
  return pino({ level }, pino.multistream(streams))
}

/**
 * Global root logger. Pretty-prints in development (NODE_ENV !== 'production'), JSON in production.
 * Replace via setLogger() to use a custom pino instance (e.g. with transports, redaction, etc.)
 */
let rootLogger: Logger = buildRootLogger()

export function getLogger(): Logger {
  return rootLogger
}

export function setLogger(logger: Logger): void {
  rootLogger = logger
}

/**
 * Create a child logger with a fixed `module` field for filtering/searching.
 * Extra bindings ride along on every line — BaseStrategy binds `instanceId`
 * so two instances of the same strategy stay distinguishable downstream.
 * Usage: const log = createLogger('CompiledLoader')
 */
export function createLogger(module: string, bindings?: Record<string, unknown>): Logger {
  return rootLogger.child({ module, ...bindings })
}
