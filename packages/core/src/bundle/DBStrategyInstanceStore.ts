import type { StrategyInstance } from '../types/instance.js'
import type { DatabaseAdapter } from '../database/DatabaseAdapter.js'

interface InstanceRow {
  [key: string]: unknown
  id: string
  name: string
  description: string | null
  strategy_id: string
  accounts: string | null
  params: string | null
  enabled: number
  created_at: string
  updated_at: string
}

function rowToInstance(row: InstanceRow): StrategyInstance {
  const instance: StrategyInstance = {
    id: row.id,
    name: row.name,
    strategyId: row.strategy_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.description !== null) instance.description = row.description
  if (row.accounts !== null) instance.accounts = JSON.parse(row.accounts) as string[]
  if (row.params !== null) instance.params = JSON.parse(row.params) as NonNullable<StrategyInstance['params']>
  return instance
}

export class DBStrategyInstanceStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async save(instance: StrategyInstance): Promise<void> {
    await this.db.run(
      `INSERT INTO strategy_instances (id, name, description, strategy_id, accounts, params, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name        = excluded.name,
         description = excluded.description,
         strategy_id = excluded.strategy_id,
         accounts    = excluded.accounts,
         params      = excluded.params,
         enabled     = excluded.enabled,
         updated_at  = excluded.updated_at`,
      [
        instance.id,
        instance.name,
        instance.description ?? null,
        instance.strategyId,
        instance.accounts ? JSON.stringify(instance.accounts) : null,
        instance.params ? JSON.stringify(instance.params) : null,
        instance.enabled ? 1 : 0,
        instance.createdAt,
        instance.updatedAt,
      ]
    )
  }

  async load(id: string): Promise<StrategyInstance | null> {
    const row = await this.db.get<InstanceRow>('SELECT * FROM strategy_instances WHERE id = ?', [id])
    return row ? rowToInstance(row) : null
  }

  async loadAll(): Promise<StrategyInstance[]> {
    const rows = await this.db.all<InstanceRow>('SELECT * FROM strategy_instances ORDER BY created_at ASC')
    return rows.map(rowToInstance)
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM strategy_instances WHERE id = ?', [id])
  }
}
