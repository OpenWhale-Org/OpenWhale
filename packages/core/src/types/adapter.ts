export interface AdapterQueryOptions {
  limit?: number
  offset?: number
  [key: string]: unknown
}

export interface AdapterExecuteOptions {
  dryRun?: boolean
  [key: string]: unknown
}

export interface IAdapter {
  readonly adapterName: string
  query(method: string, params: Record<string, unknown>, options?: AdapterQueryOptions): Promise<unknown>
  execute(action: string, params: Record<string, unknown>, options?: AdapterExecuteOptions): Promise<unknown>
}
