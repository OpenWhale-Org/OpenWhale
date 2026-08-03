import type { MonitorInstanceEntity, MonitorInstanceStore } from '../types/monitorInstance.js'
import type { DatabaseAdapter, Row } from '../database/DatabaseAdapter.js'

interface InstanceRow extends Row {
  id: string
  implementation: string
  contract: string
  credential: string | null
  params: string | null
  active: number
  created_at: string
  updated_at: string
}

function rowToEntity(row: InstanceRow): MonitorInstanceEntity {
  return {
    id: row.id,
    implementation: row.implementation,
    contract: row.contract,
    ...(row.credential !== null ? { credential: row.credential } : {}),
    ...(row.params !== null ? { params: JSON.parse(row.params) as Record<string, unknown> } : {}),
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** DB-backed monitor-instance persistence (the `monitor_instances` table). */
export class DBMonitorInstanceStore implements MonitorInstanceStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async save(entity: MonitorInstanceEntity): Promise<void> {
    await this.db.run(
      `INSERT INTO monitor_instances (id, implementation, contract, credential, params, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         implementation = excluded.implementation,
         contract       = excluded.contract,
         credential     = excluded.credential,
         params         = excluded.params,
         active         = excluded.active,
         updated_at     = excluded.updated_at`,
      [entity.id, entity.implementation, entity.contract, entity.credential ?? null, entity.params !== undefined ? JSON.stringify(entity.params) : null, entity.active ? 1 : 0, entity.createdAt, entity.updatedAt]
    )
  }

  async get(id: string): Promise<MonitorInstanceEntity | null> {
    const row = await this.db.get<InstanceRow>('SELECT * FROM monitor_instances WHERE id = ?', [id])
    return row ? rowToEntity(row) : null
  }

  async list(): Promise<MonitorInstanceEntity[]> {
    const rows = await this.db.all<InstanceRow>('SELECT * FROM monitor_instances ORDER BY created_at ASC')
    return rows.map(rowToEntity)
  }

  async delete(id: string): Promise<void> {
    await this.db.run('DELETE FROM monitor_instances WHERE id = ?', [id])
  }
}

/** In-memory store for runtimes without a database. */
export class MemoryMonitorInstanceStore implements MonitorInstanceStore {
  private readonly entities = new Map<string, MonitorInstanceEntity>()

  async save(entity: MonitorInstanceEntity): Promise<void> {
    this.entities.set(entity.id, { ...entity })
  }

  async get(id: string): Promise<MonitorInstanceEntity | null> {
    const entity = this.entities.get(id)
    return entity ? { ...entity } : null
  }

  async list(): Promise<MonitorInstanceEntity[]> {
    return Array.from(this.entities.values()).map(e => ({ ...e }))
  }

  async delete(id: string): Promise<void> {
    this.entities.delete(id)
  }
}
