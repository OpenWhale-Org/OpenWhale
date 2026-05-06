export interface MonitorRecord<TData = Record<string, unknown>> {
  ts: number
  data: TData
}

export interface MonitorDataReader<TData = Record<string, unknown>> {
  /** List all keys that have data stored for this monitor. */
  keys(): Promise<string[]>

  readLast(key: string, n: number): Promise<MonitorRecord<TData>[]>
  readLatest(key: string): Promise<MonitorRecord<TData> | null>
  readRange(key: string, from: number, to: number): Promise<MonitorRecord<TData>[]>
  count(key: string): Promise<number>
  stream(key: string): AsyncIterable<MonitorRecord<TData>>

  /** Read the latest record for every available key. */
  readAllLatest(): Promise<Map<string, MonitorRecord<TData> | null>>
  /** Read the last n records for every available key. */
  readAllLast(n: number): Promise<Map<string, MonitorRecord<TData>[]>>
}

export type EmitHandler<TData = Record<string, unknown>> = (
  key: string,
  data: TData
) => void | Promise<void>

export interface MonitorOptions {
  dataDir?: string
}
