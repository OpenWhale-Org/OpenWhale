/**
 * Adapter error taxonomy.
 *
 * Adapters translate venue/SDK errors into these classes so callers can make
 * retry decisions without knowing the venue: BaseExecutor retries retryable
 * errors and fails fast on terminal ones. Untranslated errors are treated as
 * retryable (the safe default for network-ish unknowns — but adapters should
 * translate everything they can).
 */
export abstract class AdapterError extends Error {
  constructor(
    message: string,
    /** Whether retrying the same call can plausibly succeed. */
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Transient failures: timeouts, disconnects, rate limits, venue maintenance. */
export class RetryableAdapterError extends AdapterError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, true, options)
  }
}

/** Permanent failures: bad params, insufficient funds, auth errors. Retrying cannot succeed. */
export class TerminalAdapterError extends AdapterError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, false, options)
  }
}

/**
 * True when the error declares itself non-retryable. Checks the shape rather
 * than instanceof so it survives duplicated class copies across packages.
 */
export function isTerminalError(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && 'retryable' in err && (err as { retryable: unknown }).retryable === false
}
