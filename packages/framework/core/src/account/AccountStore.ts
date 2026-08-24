import type { AccountEntity, AccountStore } from '../types/account.js'
import type { DatabaseAdapter, Row } from '../database/DatabaseAdapter.js'

interface AccountRow extends Row {
  name: string
  implementation: string
  credential: string | null
  params: string | null
  created_at: string
  updated_at: string
}

function rowToEntity(row: AccountRow): AccountEntity {
  return {
    name: row.name,
    implementation: row.implementation,
    ...(row.credential !== null ? { credential: row.credential } : {}),
    ...(row.params !== null ? { params: JSON.parse(row.params) as Record<string, unknown> } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** DB-backed account persistence (the `accounts` table). */
export class DBAccountStore implements AccountStore {
  constructor(private readonly db: DatabaseAdapter) {}

  async save(entity: AccountEntity): Promise<void> {
    await this.db.run(
      `INSERT INTO accounts (name, implementation, credential, params, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         implementation = excluded.implementation,
         credential     = excluded.credential,
         params         = excluded.params,
         updated_at     = excluded.updated_at`,
      [entity.name, entity.implementation, entity.credential ?? null, entity.params !== undefined ? JSON.stringify(entity.params) : null, entity.createdAt, entity.updatedAt]
    )
  }

  async get(name: string): Promise<AccountEntity | null> {
    const row = await this.db.get<AccountRow>('SELECT * FROM accounts WHERE name = ?', [name])
    return row ? rowToEntity(row) : null
  }

  async list(): Promise<AccountEntity[]> {
    const rows = await this.db.all<AccountRow>('SELECT * FROM accounts ORDER BY created_at ASC')
    return rows.map(rowToEntity)
  }

  async delete(name: string): Promise<void> {
    await this.db.run('DELETE FROM accounts WHERE name = ?', [name])
  }
}

/** In-memory account store — runtimes without a database (tests, embedding). */
export class MemoryAccountStore implements AccountStore {
  private readonly entities = new Map<string, AccountEntity>()

  async save(entity: AccountEntity): Promise<void> {
    this.entities.set(entity.name, { ...entity })
  }

  async get(name: string): Promise<AccountEntity | null> {
    const entity = this.entities.get(name)
    return entity ? { ...entity } : null
  }

  async list(): Promise<AccountEntity[]> {
    return Array.from(this.entities.values()).map(e => ({ ...e }))
  }

  async delete(name: string): Promise<void> {
    this.entities.delete(name)
  }
}
