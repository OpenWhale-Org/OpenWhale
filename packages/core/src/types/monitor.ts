export interface MonitorRecord<TData = Record<string, unknown>> {
  ts: number
  data: TData
}

export interface MonitorDataReader<TData = Record<string, unknown>> {
  readLast(n: number): Promise<MonitorRecord<TData>[]>
  readLatest(): Promise<MonitorRecord<TData> | null>
  readRange(from: number, to: number): Promise<MonitorRecord<TData>[]>
  count(): Promise<number>
  stream(): AsyncIterable<MonitorRecord<TData>>
}

export type EmitHandler<TData = Record<string, unknown>> = (
  key: string,
  data: TData
) => void | Promise<void>

export interface MonitorOptions {
  dataDir?: string
}
