/**
 * Generic adapter base interface.
 *
 * IAdapter is the minimal common interface for any third-party service that supports "query" and "execute".
 * Domain-specific adapters (exchange, NFT marketplace, prediction market, etc.) should extend this
 * or define their own specialized interface.
 *
 * Use cases:
 * - AI-generated strategies call external services via IAdapter without knowing the concrete implementation
 * - The plugin system registers custom adapters for reuse across monitors and executors
 */
export interface AdapterQueryOptions {
  limit?: number
  offset?: number
  [key: string]: unknown
}

export interface AdapterExecuteOptions {
  /** Dry-run mode — no side effects are produced */
  dryRun?: boolean
  [key: string]: unknown
}

export interface IAdapter {
  readonly adapterName: string
  /** Read-only query, no side effects */
  query(method: string, params: Record<string, unknown>, options?: AdapterQueryOptions): Promise<unknown>
  /** Write operation with side effects (place order, transfer, etc.) */
  execute(action: string, params: Record<string, unknown>, options?: AdapterExecuteOptions): Promise<unknown>
}
