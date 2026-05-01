import pino from 'pino'

export type LogLevel = pino.Level

export type Logger = pino.Logger

const isDev = process.env['NODE_ENV'] !== 'production'

const devOptions: pino.LoggerOptions = {
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport: { target: 'pino-pretty', options: { colorize: true, ignore: 'pid,hostname' } },
}

const prodOptions: pino.LoggerOptions = {
  level: process.env['LOG_LEVEL'] ?? 'info',
}

/**
 * Global root logger. Pretty-prints in development (NODE_ENV !== 'production'), JSON in production.
 * Replace via setLogger() to use a custom pino instance (e.g. with transports, redaction, etc.)
 */
let rootLogger: Logger = pino(isDev ? devOptions : prodOptions)

export function getLogger(): Logger {
  return rootLogger
}

export function setLogger(logger: Logger): void {
  rootLogger = logger
}

/**
 * Create a child logger with a fixed `module` field for filtering/searching.
 * Usage: const log = createLogger('CompiledLoader')
 */
export function createLogger(module: string): Logger {
  return rootLogger.child({ module })
}
